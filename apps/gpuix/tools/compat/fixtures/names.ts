export const FIXTURE_NAMES = ['statusbar', 'sidebar', 'chat', 'dialog'] as const
export type FixtureName = (typeof FIXTURE_NAMES)[number]
