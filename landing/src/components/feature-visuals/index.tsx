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

export function FeatureVisual({ id }: FeatureVisualProps) {
  switch (id) {
    case '01':
      return <FeatureVisualTabbedInterface />;
    case '02':
      return <FeatureVisualSessionPersistence />;
    case '03':
      return <FeatureVisualMultipleShells />;
    case '04':
      return <FeatureVisualCrossPlatform />;
    case '05':
      return <FeatureVisualProjectWorkspaces />;
    case '06':
      return <FeatureVisualSplitPanes />;
    case '07':
      return <FeatureVisualCodeEditor />;
    case '08':
      return <FeatureVisualBrowserAnnotations />;
    default:
      return null;
  }
}
