/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Content, Header, Item, Root, Trigger } from '../../src/compat/radix/accordion'

const plan = (rootProps: Record<string, unknown>) =>
  renderToStaticMarkup(
    h(
      Root,
      { type: 'single', collapsible: true, className: 'flex flex-col px-2 pb-1.5 pt-0.5', ...rootProps },
      h(
        Item,
        { value: 'a', className: 'border-0' },
        h(Header, { className: 'flex' }, h(Trigger, { className: 'gap-1.5' }, 'Read the router')),
        h(Content, { className: 'pl-8' }, 'Details')
      ),
      h('div', { className: 'flex items-center' }, 'Write the tests')
    )
  )

describe('the accordion stand-in renders Radix parts as the DOM does', () => {
  test("PlanPanel's root keeps its padding classes and a closed item hides its content", () => {
    expect(plan({})).toBe(
      '<div data-orientation="vertical" class="flex flex-col px-2 pb-1.5 pt-0.5">' +
        '<div data-state="closed" class="border-0">' +
        '<h3 class="flex" data-state="closed">' +
        '<button type="button" aria-expanded="false" data-state="closed" class="gap-1.5">Read the router</button>' +
        '</h3></div>' +
        '<div class="flex items-center">Write the tests</div></div>'
    )
  })

  test('an open item mounts its content', () => {
    expect(plan({ defaultValue: 'a' })).toContain(
      '<div role="region" data-state="open" class="pl-8">Details</div>'
    )
  })
})
