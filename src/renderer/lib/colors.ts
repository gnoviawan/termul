import type { ProjectColor } from '@/types/project'

export const projectColors: Record<
  ProjectColor,
  { bg: string; text: string; shadow: string; border: string; borderMuted: string }
> = {
  blue: {
    bg: 'bg-project-blue',
    text: 'text-project-blue',
    shadow: 'shadow-project-blue/50',
    border: 'border-project-blue',
    borderMuted: 'border-project-blue/40'
  },
  purple: {
    bg: 'bg-project-purple',
    text: 'text-project-purple',
    shadow: 'shadow-project-purple/50',
    border: 'border-project-purple',
    borderMuted: 'border-project-purple/40'
  },
  green: {
    bg: 'bg-project-green',
    text: 'text-project-green',
    shadow: 'shadow-project-green/50',
    border: 'border-project-green',
    borderMuted: 'border-project-green/40'
  },
  yellow: {
    bg: 'bg-project-yellow',
    text: 'text-project-yellow',
    shadow: 'shadow-project-yellow/50',
    border: 'border-project-yellow',
    borderMuted: 'border-project-yellow/40'
  },
  red: {
    bg: 'bg-project-red',
    text: 'text-project-red',
    shadow: 'shadow-project-red/50',
    border: 'border-project-red',
    borderMuted: 'border-project-red/40'
  },
  cyan: {
    bg: 'bg-project-cyan',
    text: 'text-project-cyan',
    shadow: 'shadow-project-cyan/50',
    border: 'border-project-cyan',
    borderMuted: 'border-project-cyan/40'
  },
  pink: {
    bg: 'bg-project-pink',
    text: 'text-project-pink',
    shadow: 'shadow-project-pink/50',
    border: 'border-project-pink',
    borderMuted: 'border-project-pink/40'
  },
  orange: {
    bg: 'bg-project-orange',
    text: 'text-project-orange',
    shadow: 'shadow-project-orange/50',
    border: 'border-project-orange',
    borderMuted: 'border-project-orange/40'
  },
  gray: {
    bg: 'bg-project-gray',
    text: 'text-project-gray',
    shadow: 'shadow-project-gray/50',
    border: 'border-project-gray',
    borderMuted: 'border-project-gray/40'
  }
}

export const statusBarColors: Record<ProjectColor, string> = {
  blue: 'bg-status-bar-blue',
  purple: 'bg-status-bar-purple',
  green: 'bg-status-bar-green',
  yellow: 'bg-status-bar-yellow',
  red: 'bg-status-bar-red',
  cyan: 'bg-status-bar-cyan',
  pink: 'bg-status-bar-pink',
  orange: 'bg-status-bar-orange',
  gray: 'bg-status-bar-gray'
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
