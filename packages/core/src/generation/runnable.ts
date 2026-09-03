import type { Checkpoint, SourceFile } from '../schemas/step.js';

/**
 * What the checkpoint sandbox can actually execute.
 *
 * Checkpoint tests do not run on a machine we provision — they run in the
 * learner's browser, under Pyodide for Python and a bare JS realm for web.
 * Neither can install anything. A step that legitimately needs FastAPI, or
 * React, is still a good step to teach; it just cannot be auto-verified, and a
 * test that can never pass is worse than no test at all. It blocks the learner
 * on work they did correctly and hands them an error whose fix is not in their
 * hands.
 *
 * The generation prompt says all this, but a prompt is advice. This module is
 * the enforcement: it reads what the step's own files import and downgrades the
 * checkpoint to `runtime: "none"` when the sandbox could not have run it. The
 * static layers — required files, required symbols — still apply, so the step
 * keeps a real check.
 */

/*
 * Python 3.12 standard library, the version Pyodide ships.
 *
 * Deliberately generous: it includes the modules 3.13 dropped, because Pyodide
 * is behind and a false positive here silently costs a step its tests. Pyodide
 * can also serve third-party wheels through micropip, but nothing loads them on
 * this path, so only the standard library counts as present.
 */
const PY_STDLIB_NAMES =
  '__future__,_abc,_aix_support,_ast,_asyncio,_bisect,_blake2,_bz2,_codecs,_codecs_cn,_codecs_hk,' +
  '_codecs_iso2022,_codecs_jp,_codecs_kr,_codecs_tw,_collections,_collections_abc,_compat_pickle,' +
  '_compression,_contextvars,_csv,_ctypes,_curses,_curses_panel,_datetime,_dbm,_decimal,_elementtree,' +
  '_frozen_importlib,_frozen_importlib_external,_functools,_gdbm,_hashlib,_heapq,_imp,_io,_json,_locale,' +
  '_lsprof,_lzma,_markupbase,_md5,_msi,_multibytecodec,_multiprocessing,_opcode,_operator,_osx_support,' +
  '_pickle,_posixshmem,_posixsubprocess,_py_abc,_pydatetime,_pydecimal,_pyio,_pylong,_queue,_random,' +
  '_sha1,_sha2,_sha3,_signal,_sitebuiltins,_socket,_sqlite3,_sre,_ssl,_stat,_statistics,_string,' +
  '_strptime,_struct,_symtable,_thread,_threading_local,_tkinter,_tokenize,_tracemalloc,_typing,_uuid,' +
  '_warnings,_weakref,_weakrefset,_winapi,_zoneinfo,abc,aifc,antigravity,argparse,array,ast,asynchat,' +
  'asyncio,asyncore,atexit,audioop,base64,bdb,binascii,bisect,builtins,bz2,cProfile,calendar,cgi,cgitb,' +
  'chunk,cmath,cmd,code,codecs,codeop,collections,colorsys,compileall,concurrent,configparser,contextlib,' +
  'contextvars,copy,copyreg,crypt,csv,ctypes,curses,dataclasses,datetime,dbm,decimal,difflib,dis,' +
  'distutils,doctest,email,encodings,ensurepip,enum,errno,faulthandler,fcntl,filecmp,fileinput,fnmatch,' +
  'fractions,ftplib,functools,gc,genericpath,getopt,getpass,gettext,glob,graphlib,grp,gzip,hashlib,heapq,' +
  'hmac,html,http,idlelib,imaplib,imghdr,imp,importlib,inspect,io,ipaddress,itertools,json,keyword,' +
  'lib2to3,linecache,locale,logging,lzma,mailbox,mailcap,marshal,math,mimetypes,mmap,modulefinder,msilib,' +
  'msvcrt,multiprocessing,netrc,nis,nntplib,nt,ntpath,nturl2path,numbers,opcode,operator,optparse,os,' +
  'ossaudiodev,pathlib,pdb,pickle,pickletools,pipes,pkgutil,platform,plistlib,poplib,posix,posixpath,' +
  'pprint,profile,pstats,pty,pwd,py_compile,pyclbr,pydoc,pydoc_data,pyexpat,queue,quopri,random,re,' +
  'readline,reprlib,resource,rlcompleter,runpy,sched,secrets,select,selectors,shelve,shlex,shutil,signal,' +
  'site,smtpd,smtplib,sndhdr,socket,socketserver,spwd,sqlite3,sre_compile,sre_constants,sre_parse,ssl,' +
  'stat,statistics,string,stringprep,struct,subprocess,sunau,symtable,sys,sysconfig,syslog,tabnanny,' +
  'tarfile,telnetlib,tempfile,termios,textwrap,this,threading,time,timeit,tkinter,token,tokenize,tomllib,' +
  'trace,traceback,tracemalloc,tty,turtle,turtledemo,types,typing,unicodedata,unittest,urllib,uu,uuid,' +
  'venv,warnings,wave,weakref,webbrowser,winreg,winsound,wsgiref,xdrlib,xml,xmlrpc,zipapp,zipfile,' +
  'zipimport,zlib,zoneinfo';

export const PY_STDLIB: ReadonlySet<string> = new Set(PY_STDLIB_NAMES.split(','));

const PY_FILE = /\.py$/i;
const JS_FILE = /\.(js|mjs)$/i;

/**
 * Top-level module names a Python source imports.
 *
 * Line-based on purpose: the alternative is a parser, and this only has to be
 * good enough to notice `import fastapi`. Relative imports are skipped — they
 * resolve inside the project, which the sandbox writes to disk.
 */
export function pythonImportRoots(source: string): string[] {
  const roots = new Set<string>();

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const from = /^from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(line);
    if (from?.[1]) {
      roots.add(from[1].split('.')[0]!);
      continue;
    }

    const plain = /^import\s+(.+)$/.exec(line);
    if (!plain?.[1]) continue;

    for (const clause of plain[1].split(',')) {
      const name = clause.trim().split(/\s+as\s+/)[0]?.trim();
      if (!name) continue;
      const root = name.split('.')[0];
      if (root && /^[A-Za-z_]\w*$/.test(root)) roots.add(root);
    }
  }

  return [...roots];
}

/**
 * Package specifiers a JS source pulls in — `react`, not `./helpers.js`.
 *
 * Anything relative or absolute is part of the submission. A bare specifier is
 * an npm package, and there is no bundler or registry in the sandbox.
 */
export function jsBareSpecifiers(source: string): string[] {
  const bare = new Set<string>();
  const add = (spec: string | undefined): void => {
    if (!spec) return;
    if (spec.startsWith('.') || spec.startsWith('/') || spec.includes('://')) return;
    bare.add(spec.split('/')[0]!);
  };

  const patterns = [
    /\bimport\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) add(match[1]);
  }

  return [...bare];
}

/**
 * Imports in these files that the sandbox for `runtime` cannot resolve.
 *
 * Empty means the step is runnable as written.
 */
export function unrunnableImports(
  files: readonly SourceFile[],
  runtime: Checkpoint['runtime'],
): string[] {
  const missing = new Set<string>();

  for (const file of files) {
    if (runtime === 'python' && PY_FILE.test(file.path)) {
      for (const root of pythonImportRoots(file.contents)) {
        if (!PY_STDLIB.has(root)) missing.add(root);
      }
    } else if (runtime === 'web' && JS_FILE.test(file.path)) {
      for (const spec of jsBareSpecifiers(file.contents)) missing.add(spec);
    }
  }

  return [...missing].sort();
}

/**
 * Turns off automatic checking for a step the sandbox could never have run.
 *
 * The tests go with it. Keeping tests the runner will skip only preserves the
 * illusion that the step is verified, and they are written against an
 * environment that does not exist.
 */
export function groundCheckpoint(
  checkpoint: Checkpoint,
  files: readonly SourceFile[],
): Checkpoint {
  if (checkpoint.runtime === 'none' || checkpoint.tests.length === 0) return checkpoint;

  const missing = unrunnableImports(files, checkpoint.runtime);
  if (missing.length === 0) return checkpoint;

  return { ...checkpoint, runtime: 'none', tests: [] };
}
