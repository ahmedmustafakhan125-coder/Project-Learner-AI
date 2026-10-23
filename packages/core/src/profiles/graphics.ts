import { basicProfile } from './basic.js';

export const graphics = basicProfile({
  id: 'graphics',
  label: 'Graphics',
  signalWords: [
    'ray tracer', 'raytracer', 'ray tracing', 'rasteriser', 'rasterizer', 'renderer', 'shader',
    'shaders', 'opengl', 'vulkan', 'webgl', 'webgpu', 'metal', 'glsl', 'wgsl', '3d viewer', 'graphics',
  ],
  layers: [
    ['math', 'Math', 'Foundation', 'Vectors, matrices and quaternions.'],
    ['windowing', 'Windowing and context', 'Platform', 'GLFW, SDL, winit or a canvas.'],
    ['graphics-api', 'Graphics API', 'GPU', 'WebGL2, WebGPU, OpenGL, Vulkan or Metal, or none for a CPU renderer.'],
    ['shader-language', 'Shader language', 'GPU', 'GLSL, WGSL or HLSL to SPIR-V.'],
    ['assets', 'Asset loading', 'Content', 'OBJ or glTF models and textures.'],
    ['renderer-architecture', 'Renderer architecture', 'Core', 'Forward, deferred or a render graph.'],
    ['image-output', 'Image output', 'Output', 'Writing a frame to a file or the screen.'],
    ['debugging', 'Debugging tools', 'Tools', 'RenderDoc and validation layers.'],
  ],
  requiredLayersByTier: {
    T1: ['math', 'image-output'],
    T2: ['math', 'renderer-architecture', 'image-output'],
    T3: ['math', 'windowing', 'graphics-api', 'shader-language', 'renderer-architecture', 'image-output'],
    T4: [
      'math', 'windowing', 'graphics-api', 'shader-language', 'assets', 'renderer-architecture',
      'image-output', 'debugging',
    ],
    T5: [
      'math', 'windowing', 'graphics-api', 'shader-language', 'assets', 'renderer-architecture',
      'image-output', 'debugging',
    ],
  },
  tierFloors: [
    { goal: 'A CPU renderer', tier: 'T2', keywords: [] },
    { goal: 'A Vulkan renderer', tier: 'T4', keywords: ['vulkan'] },
  ],
  rule: 'The renderer exposes one function that renders a named test scene to an offscreen buffer at a fixed size.',
  harnesses: ['golden-image', 'pixel-probes', 'unit'],
  browser: true,
});
