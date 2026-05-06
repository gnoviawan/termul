import { readFileSync } from 'fs'

function assertContains(content, needle, errorMessage) {
  if (!content.includes(needle)) {
    throw new Error(errorMessage)
  }
}

function main() {
  const appTsx = readFileSync('src/renderer/App.tsx', 'utf8')
  const workflow = readFileSync('.github/workflows/pr-validation.yml', 'utf8')

  assertContains(
    appTsx,
    'production baseline stays',
    'App.tsx no longer documents the guarded xterm 5.5 baseline posture.',
  )

  assertContains(
    appTsx,
    'xterm 5.5 baseline',
    'App.tsx no longer documents the guarded xterm 5.5 baseline posture.',
  )

  assertContains(
    workflow,
    'Verify xterm adoption gate',
    'pr-validation.yml is missing the xterm adoption gate step.',
  )

  console.log('xterm adoption gate verified: baseline remains guarded')
}

main()
