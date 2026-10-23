/* ------------------------------------------------------------------ *
 * Attachment storage
 *
 * `POST /api/attachments` keeps each uploaded file in the `attachments`
 * storage bucket, at <user id>/<random id>/<file name>, and its screened text
 * in the `attachments` table. Nothing ever created the bucket, so on a new
 * project every upload that passed screening failed with "Bucket not found".
 *
 * The bucket is private and has no policies, on purpose. Only the API touches
 * it, with the service-role key, which bypasses RLS, and nothing reads the
 * files back. With no policy, neither the anon key nor a learner's own token
 * can list, fetch or upload anything in it.
 *
 * There is no size limit or type list either. The route already refuses files
 * over 2 MB, and it accepts code by file extension, so a type list would turn
 * away files the browser labels oddly: a .ts file often arrives as video/mp2t.
 * ------------------------------------------------------------------ */

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do update set public = false;
