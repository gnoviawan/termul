import type { ComponentType } from 'react';

import type { FeatureId } from '../../data/features';
import { FeatureVisualTabbedInterface } from './FeatureVisualTabbedInterface';
import { FeatureVisualSessionPersistence } from './FeatureVisualSessionPersistence';
import { FeatureVisualMultipleShells } from './FeatureVisualMultipleShells';
import { FeatureVisualCrossPlatform } from './FeatureVisualCrossPlatform';
import { FeatureVisualProjectWorkspaces } from './FeatureVisualProjectWorkspaces';
import { FeatureVisualSplitPanes } from './FeatureVisualSplitPanes';
import { FeatureVisualCodeEditor } from './FeatureVisualCodeEditor';
import { FeatureVisualBrowserAnnotations } from './FeatureVisualBrowserAnnotations';

type FeatureVisualProps = {
  id: FeatureId;
};

const featureVisuals: Record<FeatureId, ComponentType> = {
  '01': FeatureVisualTabbedInterface,
  '02': FeatureVisualSessionPersistence,
  '03': FeatureVisualMultipleShells,
  '04': FeatureVisualCrossPlatform,
  '05': FeatureVisualProjectWorkspaces,
  '06': FeatureVisualSplitPanes,
  '07': FeatureVisualCodeEditor,
  '08': FeatureVisualBrowserAnnotations,
};

export function FeatureVisual({ id }: FeatureVisualProps) {
  const Visual = featureVisuals[id];

  return <Visual />;
}
