import tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { noSvgSpin } from '../eslint/no-svg-spin.mjs';

// vitest has no globals: RuleTester registers its cases through these.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

const svgSpin = { messageId: 'svgSpin' };

ruleTester.run('no-svg-spin', noSvgSpin, {
  valid: [
    'const a = <Spinner className="h-4 w-4 text-muted-foreground" />;',
    'const a = <Radio className="size-3 animate-pulse" />;',
    'const a = <div className="animate-spinner-in spin-slow" />;',
    'const a = <div className="animate-[spinup_1s_ease-out]" />;',
    '// animate-spin in a comment is prose, not a class.\nconst a = 1;',
  ],
  invalid: [
    { code: 'const a = <Loader2 className="h-4 w-4 animate-spin" />;', errors: [svgSpin] },
    { code: 'const a = <Loader2 className="motion-safe:animate-spin" />;', errors: [svgSpin] },
    {
      code: "const a = <Icon className={cn('size-4', busy && 'animate-spin')} />;",
      errors: [svgSpin],
    },
    { code: 'const a = <Icon className={`size-4 ${x} animate-spin`} />;', errors: [svgSpin] },
    { code: "const SPIN = 'motion-safe:animate-[spin_2s_linear_infinite]';", errors: [svgSpin] },
    { code: 'const a = <Loader2 className="motion-safe:animate-spin-slow" />;', errors: [svgSpin] },
    { code: 'const a = <Loader2 className="animate-[spin]" />;', errors: [svgSpin] },
    {
      code: 'const a = <Loader2 className="!animate-spin size-3 animate-spin!" />;',
      errors: [svgSpin, svgSpin],
    },
  ],
});
