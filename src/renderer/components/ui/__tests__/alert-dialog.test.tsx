import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle
} from '../alert-dialog'

describe('AlertDialogAction press scale', () => {
  it('opts the default confirm action out of the document press transform', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Delete file</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    )

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute(
      'data-press-feedback',
      'off'
    )
    // Outline cancel keeps the document transform press.
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toHaveAttribute(
      'data-press-feedback'
    )
  })

  it('keeps a caller press-feedback override', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Confirm</AlertDialogTitle>
          <AlertDialogDescription>Continue.</AlertDialogDescription>
          <AlertDialogAction data-press-feedback="on">OK</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    )

    expect(screen.getByRole('button', { name: 'OK' })).toHaveAttribute('data-press-feedback', 'on')
  })
})
