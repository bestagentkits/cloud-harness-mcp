import type { ComponentProps } from 'react';
import { Input } from './input';

/**
 * A write-only secret value input (provider keys, secret values, credentials). It is a
 * password field the browser must not autofill or offer to save, with spellcheck and
 * autocorrect off so the value never reaches a dictionary service. Forms that hold one keep
 * no draft: callers reset the value on close and before the request settles.
 */
export function SecretInput(props: Omit<ComponentProps<'input'>, 'type'>) {
  return (
    <Input
      type="password"
      autoComplete="new-password"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore=""
      data-lpignore="true"
      data-secret-input=""
      {...props}
    />
  );
}
