import type { ProjectColor } from '@/types/project'

export const projectColors: Record<ProjectColor, { bg: string; text: string; shadow: string }> = {
  blue: { bg: 'bg-project-blue', text: 'text-project-blue', shadow: 'shadow-blue-500/50' },
  purple: { bg: 'bg-project-purple', text: 'text-project-purple', shadow: 'shadow-purple-500/50' },
  green: { bg: 'bg-project-green', text: 'text-project-green', shadow: 'shadow-green-500/50' },
  yellow: { bg: 'bg-project-yellow', text: 'text-project-yellow', shadow: 'shadow-yellow-500/50' },
  red: { bg: 'bg-project-red', text: 'text-project-red', shadow: 'shadow-red-500/50' },
  cyan: { bg: 'bg-project-cyan', text: 'text-project-cyan', shadow: 'shadow-cyan-500/50' },
  pink: { bg: 'bg-project-pink', text: 'text-project-pink', shadow: 'shadow-pink-500/50' },
  orange: { bg: 'bg-project-orange', text: 'text-project-orange', shadow: 'shadow-orange-500/50' },
  gray: { bg: 'bg-gray-500', text: 'text-gray-500', shadow: 'shadow-gray-500/50' }
}

export const statusBarColors: Record<ProjectColor, string> = {
  blue: 'bg-blue-600',
  purple: 'bg-purple-600',
  green: 'bg-green-600',
  yellow: 'bg-yellow-600',
  red: 'bg-red-600',
  cyan: 'bg-cyan-600',
  pink: 'bg-pink-600',
  orange: 'bg-orange-600',
  gray: 'bg-gray-600'
}

export const availableColors: ProjectColor[] = [
  'blue',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'green',
  'cyan',
  'gray'
]

export function getColorClasses(color: ProjectColor) {
  return projectColors[color] || projectColors.blue
}
