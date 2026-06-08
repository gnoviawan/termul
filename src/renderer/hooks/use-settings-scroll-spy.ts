import { useEffect, useState } from 'react'

interface UseSettingsScrollSpyOptions {
  container: HTMLElement | null
  sectionIds: string[]
}

export function useSettingsScrollSpy({
  container,
  sectionIds
}: UseSettingsScrollSpyOptions): string | undefined {
  const [activeId, setActiveId] = useState<string | undefined>(sectionIds[0])

  useEffect(() => {
    setActiveId(sectionIds[0])
  }, [sectionIds.join(',')])

  useEffect(() => {
    if (!container || !sectionIds.length) {
      return
    }

    const visibleSections = new Map<string, number>()

    const updateActiveSection = (): void => {
      const next = Array.from(visibleSections.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([sectionId]) => sectionId)[0]

      setActiveId(next ?? sectionIds[0])
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const element = entry.target as HTMLElement
          const sectionId = element.dataset.settingsSection

          if (!sectionId) {
            return
          }

          if (entry.isIntersecting) {
            visibleSections.set(sectionId, entry.boundingClientRect.top)
          } else {
            visibleSections.delete(sectionId)
          }
        })

        updateActiveSection()
      },
      {
        root: container,
        threshold: [0, 0.1, 0.25],
        rootMargin: '0px 0px -65% 0px'
      }
    )

    const elements = sectionIds
      .map((id) => container.querySelector<HTMLElement>(`[data-settings-section="${id}"]`))
      .filter((element): element is HTMLElement => {
        if (!element) {
          return false
        }

        return window.getComputedStyle(element).display !== 'none'
      })

    elements.forEach((element) => {
      observer.observe(element)
    })

    return () => {
      observer.disconnect()
      visibleSections.clear()
    }
  }, [container, sectionIds.join(',')])

  return activeId
}
