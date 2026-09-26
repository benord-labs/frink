// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './alert-dialog';
import {
  CanvasDialogBody,
  CanvasDialogContent,
  CanvasDialogFooter,
  CanvasDialogHeader,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './dialog';

afterEach(cleanup);

describe('DialogContent', () => {
  it.each([true, false])('wears the glass material only when glass=%s', (glass) => {
    render(
      <Dialog open>
        <DialogContent glass={glass}>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Body</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    const classes = screen.getByRole('dialog').classList;
    expect(classes.contains('glass-lit')).toBe(glass);
    expect(classes.contains('bg-popover/(--glass-opacity)')).toBe(glass);
    expect(classes.contains('backdrop-filter-(--glass-filter)')).toBe(glass);
  });
});

describe('dialog section parts', () => {
  it.each([
    ['header', AlertDialogHeader, CanvasDialogHeader],
    ['body', AlertDialogBody, CanvasDialogBody],
    ['footer', AlertDialogFooter, CanvasDialogFooter],
  ])('alert and canvas dialogs share one %s', (_part, alertPart, canvasPart) => {
    expect(alertPart).toBe(canvasPart);
  });

  it.each([
    ['alert', 'alertdialog', AlertDialog, AlertDialogContent, AlertDialogTitle],
    ['canvas', 'dialog', Dialog, CanvasDialogContent, DialogTitle],
  ])('the shared title labels the %s dialog', (_kind, role, Root, Content, Title) => {
    render(
      <Root open>
        <Content aria-describedby={undefined}>
          <Title>Delete file?</Title>
        </Content>
      </Root>,
    );

    expect(screen.getByRole(role, { name: 'Delete file?' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Delete file?' })).toHaveClass(
      'text-lg font-semibold',
    );
  });
});
