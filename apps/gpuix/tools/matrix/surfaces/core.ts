import type { Surface } from '../types'

export const CORE: Surface[] = [
  {
    id: 'rail.project-list',
    area: 'rail',
    title: 'Rail: project list and switching',
    roi: '[data-testid="shell-rail"]',
    steps: [
      { name: 'a-dashboard', actions: [], expect: [{ text: 'alpha' }, { text: 'beta' }, { text: 'gamma' }] },
      {
        name: 'b-switch-beta',
        actions: [{ do: 'click', target: { testId: 'project-item-m1-beta' } }],
        expect: [{ text: 'What should we do in beta?' }]
      }
    ]
  }
]
