import type { ComponentType } from 'react';

import type { FeatureId } from '../../data/features';
import { FeatureVisualTabbedInterface } from './FeatureVisualTabbedInterface';
import { FeatureVisualMultipleShells } from './FeatureVisualMultipleShells';
import { FeatureVisualProjectWorkspaces } from './FeatureVisualProjectWorkspaces';
import { FeatureVisualSplitPanes } from './FeatureVisualSplitPanes';
import { FeatureVisualCodeEditor } from './FeatureVisualCodeEditor';
import { FeatureVisualBrowserAnnotations } from './FeatureVisualBrowserAnnotations';
import { FeatureVisualGitPanel } from './FeatureVisualGitPanel';
import { FeatureVisualGitWorktree } from './FeatureVisualGitWorktree';
import { FeatureVisualCommandPalette } from './FeatureVisualCommandPalette';

type FeatureVisualProps = {
  id: FeatureId;
};

const featureVisuals: Partial<Record<FeatureId, ComponentType>> = {
  '01': FeatureVisualTabbedInterface,
  '02': FeatureVisualMultipleShells,
  '03': FeatureVisualProjectWorkspaces,
  '04': FeatureVisualSplitPanes,
  '05': FeatureVisualCodeEditor,
  '06': FeatureVisualBrowserAnnotations,
  '07': FeatureVisualGitPanel,
  '08': FeatureVisualGitWorktree,
  '09': FeatureVisualCommandPalette,
};

export function FeatureVisual({ id }: FeatureVisualProps) {
  const Visual = featureVisuals[id];

  if (!Visual) return null;

  return <Visual />;
}
