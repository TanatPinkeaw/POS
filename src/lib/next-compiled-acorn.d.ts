/*
 * The bundled acorn Next ships (`next/dist/compiled/acorn`) is the parser this gate
 * uses, and it carries no type declarations — an internal package on purpose.
 *
 * The alternative was adding `acorn` as a devDependency, which rule 2 of AGENTS.md
 * forbids for something this small, and which would also mean the gate parses with a
 * *different* acorn than the toolchain around it. A declaration of the one function we
 * call is the cheaper honesty, and it fails loudly if Next ever moves the file: the
 * import resolves to nothing and the gate goes red rather than silently skipping.
 */
declare module 'next/dist/compiled/acorn' {
  interface AcornNode {
    type: string;
    start: number;
    end: number;
    [key: string]: unknown;
  }

  interface ParseOptions {
    ecmaVersion: number;
    sourceType?: 'script' | 'module';
    allowHashBang?: boolean;
  }

  export function parse(source: string, options: ParseOptions): AcornNode;
}
