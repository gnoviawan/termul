import type { ThemeRegistrationResolved } from 'shiki'
import { getColorThemeDefinition } from './bundled-themes'
import { resolveSyntaxColors } from './resolve-syntax'
import { getLightThemeId, normalizeThemeFamilyId } from './theme-appearance'
import type { ColorThemeDefinition, ResolvedSyntaxColors } from './types'

function surface(theme: ColorThemeDefinition): { bg: string; fg: string } {
  const { palette, chrome } = theme.dark
  return {
    bg: chrome?.background ?? palette.neutral,
    fg: chrome?.foreground ?? palette.ink
  }
}

/**
 * TextMate theme whose token colors are the editor's resolved syntax map.
 * Chat fences and diff blocks load this so they match CodeMirror.
 */
export function syntaxThemeFor(theme: ColorThemeDefinition): ThemeRegistrationResolved {
  const colors: ResolvedSyntaxColors = resolveSyntaxColors(theme)
  const { bg, fg } = surface(theme)

  return {
    name: `termul-syntax-${theme.id}`,
    displayName: `${theme.name} syntax`,
    type: theme.appearance,
    fg,
    bg,
    settings: [
      { settings: { foreground: fg, background: bg } },
      {
        scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
        settings: { foreground: colors.comment, fontStyle: 'italic' }
      },
      {
        scope: [
          'keyword',
          'storage',
          'storage.type',
          'keyword.control',
          'constant.language',
          'variable.language'
        ],
        settings: { foreground: colors.keyword }
      },
      {
        scope: ['constant.language.boolean', 'constant.language.null'],
        settings: { foreground: colors.bool }
      },
      {
        scope: ['string', 'punctuation.definition.string', 'string.regexp'],
        settings: { foreground: colors.string }
      },
      {
        scope: ['constant.numeric'],
        settings: { foreground: colors.number }
      },
      {
        scope: [
          'entity.name.function',
          'support.function',
          'meta.function-call',
          'meta.function-call entity.name.function'
        ],
        settings: { foreground: colors.function }
      },
      {
        scope: [
          'entity.name.type',
          'entity.name.class',
          'support.type',
          'support.class',
          'storage.type.class',
          'storage.type.interface'
        ],
        settings: { foreground: colors.type }
      },
      {
        scope: ['variable', 'variable.other', 'variable.parameter', 'variable.other.readwrite'],
        settings: { foreground: colors.variable }
      },
      {
        scope: [
          'variable.other.property',
          'variable.other.object.property',
          'meta.object-literal.key',
          'support.type.property-name'
        ],
        settings: { foreground: colors.property }
      },
      {
        scope: ['entity.name.tag', 'support.class.component'],
        settings: { foreground: colors.tag }
      },
      {
        scope: ['entity.other.attribute-name'],
        settings: { foreground: colors.attributeName }
      },
      {
        scope: ['keyword.operator', 'storage.type.function.arrow'],
        settings: { foreground: colors.operator }
      },
      {
        scope: ['punctuation'],
        settings: { foreground: colors.punctuation }
      },
      {
        scope: ['markup.heading', 'markup.heading entity.name'],
        settings: { foreground: colors.heading, fontStyle: 'bold' }
      },
      {
        scope: ['markup.underline.link', 'string.other.link', 'constant.other.reference.link'],
        settings: { foreground: colors.link, fontStyle: 'underline' }
      }
    ]
  }
}

/** Light theme first, dark theme second. Streamdown switches them with `.dark`. */
export function syntaxShikiPair(
  themeId: string
): [ThemeRegistrationResolved, ThemeRegistrationResolved] {
  const dark = getColorThemeDefinition(normalizeThemeFamilyId(themeId))
  const light = getColorThemeDefinition(getLightThemeId(dark.familyId))
  return [syntaxThemeFor(light), syntaxThemeFor(dark)]
}
