import type { TechChoice } from '../schemas/project.js';
import type { StackBrief } from '../schemas/stack.js';

/**
 * `blueprint.techStack`, derived from the approved brief by code and never
 * regenerated (invariant 17): the brief is the only source of stack truth.
 * Layer order is kept, so the same brief always gives the same list.
 */
export function techStackFromBrief(brief: StackBrief): TechChoice[] {
  return brief.layers.map((layer) => {
    const version = layer.versionMajor?.trim();
    const named = version && !new RegExp(`\\b${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(layer.name);
    return {
      name: named ? `${layer.name} ${version}` : layer.name,
      role: layer.roleHere,
      why: layer.whyChosen,
    };
  });
}
