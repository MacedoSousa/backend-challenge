import { describe, expect, it } from 'bun:test';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const domainFiles = Array.from(new Bun.Glob('src/**/domain/**/*.ts').scanSync({ cwd: ROOT }));

const read = (file: string) => Bun.file(join(ROOT, file)).text();

/** Dependências de infraestrutura proibidas na camada de domínio (regra de dependência). */
const FORBIDDEN_IMPORTS = [
  /from ['"]@nestjs\//,
  /from ['"]@mikro-orm\//,
  /from ['"]@aws-sdk\//,
  /from ['"]pino['"]/,
  /from ['"]express['"]/,
  /from ['"]zod['"]/,
  /from ['"][./]+(?:[^'"]*\/)?(infrastructure|application|presentation)\//,
];

/** Conversões que levariam dinheiro para ponto flutuante (restrição inviolável 1). */
const FLOAT_CONVERSIONS = [
  /\bparseFloat\(/,
  /\bparseInt\(/,
  /\bNumber\(/,
  /\.toFixed\(/,
  /\bMath\.round\(/,
];

describe('arquitetura do domínio', () => {
  it('existem arquivos de domínio para verificar', () => {
    expect(domainFiles.length).toBeGreaterThan(5);
  });

  it.each(domainFiles)(
    '%s não depende de framework, ORM, SDK ou camadas externas',
    async (file) => {
      const source = await read(file);
      const violations = FORBIDDEN_IMPORTS.filter((pattern) => pattern.test(source));
      expect(violations.map(String)).toEqual([]);
    },
  );

  it.each(domainFiles)('%s não converte valores para number', async (file) => {
    const source = await read(file);
    const violations = FLOAT_CONVERSIONS.filter((pattern) => pattern.test(source));
    expect(violations.map(String), relative(ROOT, file)).toEqual([]);
  });
});
