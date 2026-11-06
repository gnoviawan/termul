/**
 * One-line plain text for a comment preview: bots (CodeRabbit and others)
 * open their comments with HTML comments, `<picture>` icons and folded
 * `<details>` evidence, which read as markup noise in a two-line clamp.
 */
export function plainPreview(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<details[\s\S]*?<\/details>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
