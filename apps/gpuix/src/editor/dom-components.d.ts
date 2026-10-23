/**
 * Type-side stand-in for the shared DOM components the native editor renders
 * through the compat runtime (their JSX is typed against React DOM).
 * tsconfig.editor.json maps each specifier here; the bundler resolves the
 * real files, and the web build checks them.
 */
import type { ComponentType } from 'react'

type SharedComponent = ComponentType<Record<string, unknown>>

export declare const TocPanel: SharedComponent
export declare const FrontmatterProperties: SharedComponent

export type TocVariant = 'panel' | 'strip'
