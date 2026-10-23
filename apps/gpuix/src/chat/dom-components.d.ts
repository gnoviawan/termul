/**
 * Type-side stand-in for the shared DOM components the native transcript
 * renders through the compat runtime. Their JSX is typed against React DOM,
 * so they cannot join a program that types JSX against GPUIX; this program
 * (tsconfig.chat.json) maps each specifier here instead. The bundler resolves
 * the real files, and tsconfig.compat.json / the web build check them.
 */

import type { ComponentType } from 'react'

type SharedComponent = ComponentType<Record<string, unknown>>

export declare const AgentSwitchSeparator: SharedComponent
export declare const ChatEmptyState: SharedComponent
export declare const ChatMessage: SharedComponent
export declare const RowReveal: SharedComponent
export declare const SubagentDetailsDialog: SharedComponent
export declare const ToolCallCard: SharedComponent
export declare const TurnActivity: SharedComponent
export declare const WorktreeCreationCard: SharedComponent
export declare const TermulPlanRenderer: SharedComponent
