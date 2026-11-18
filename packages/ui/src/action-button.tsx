import React, { type ComponentPropsWithoutRef } from 'react';

export function ActionButton({ blocked, disabled, onClick, ...props }: ComponentPropsWithoutRef<'button'> & { blocked: boolean }) {
  // A short write lock should keep the control in place and preserve keyboard focus.
  return <button type="button" {...props} disabled={disabled} aria-disabled={!disabled && blocked || undefined} onClick={event => {
    if (!disabled && !blocked) onClick?.(event);
  }} />;
}
