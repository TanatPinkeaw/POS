import { describe, expect, it } from 'vitest';

import { DEFAULT_POSTGRES_PORT, parseDatabaseUrl } from '../src/lib/database-url';

/** The exact string `npm run setup` writes, which is the one most shops will have. */
const INSTALLER_URL = 'postgresql://pos_app:pos_app@localhost:5432/pos_dev?schema=public';

describe('a connection string', () => {
  it('splits the URL the installer writes', () => {
    expect(parseDatabaseUrl(INSTALLER_URL)).toEqual({
      host: 'localhost',
      port: 5432,
      user: 'pos_app',
      password: 'pos_app',
      database: 'pos_dev',
    });
  });

  it('drops the Prisma-only query string, which libpq would refuse', () => {
    // The whole reason this module exists: `pg_dump "…?schema=public"` fails with
    // `invalid URI query parameter`, so the parts are what get passed on.
    const parts = parseDatabaseUrl(`${INSTALLER_URL}&connect_timeout=10`);

    expect(parts.database).toBe('pos_dev');
    expect(parts.host).toBe('localhost');
  });

  it('accepts the short scheme and a remote host', () => {
    expect(parseDatabaseUrl('postgres://pos_app:secret@10.0.0.5/pos_dev?schema=public')).toEqual({
      host: '10.0.0.5',
      port: 5432,
      user: 'pos_app',
      password: 'secret',
      database: 'pos_dev',
    });
  });

  it('assumes the default port when the URL names none', () => {
    expect(parseDatabaseUrl('postgresql://u:p@db/pos').port).toBe(DEFAULT_POSTGRES_PORT);
  });

  it('keeps a non-default port', () => {
    expect(parseDatabaseUrl('postgresql://u:p@db:6432/pos').port).toBe(6432);
  });

  it('decodes a percent-encoded user and password', () => {
    expect(parseDatabaseUrl('postgresql://u%40x:p%40ss%3Aword@db/pos')).toMatchObject({
      user: 'u@x',
      password: 'p@ss:word',
    });
  });

  it('leaves a literal percent sign alone rather than failing the backup', () => {
    expect(parseDatabaseUrl('postgresql://u:100%25off@db/pos').password).toBe('100%off');
    expect(parseDatabaseUrl('postgresql://u:100%off@db/pos').password).toBe('100%off');
  });

  it('accepts an empty password, which is how trust and peer auth look', () => {
    expect(parseDatabaseUrl('postgresql://pos_app@localhost/pos_dev').password).toBe('');
  });
});

describe('a connection string that cannot be used', () => {
  it('refuses something that is not a URL', () => {
    expect(() => parseDatabaseUrl('pos_dev')).toThrow(/not a URL/);
  });

  it('refuses a host written without a scheme, which is the usual typo', () => {
    // WHATWG URL reads `localhost:5432` as a scheme, so this lands on the protocol
    // check rather than the parse check — the message has to still be about the URL.
    expect(() => parseDatabaseUrl('localhost:5432/pos_dev')).toThrow(/postgresql:\/\//);
  });

  it('refuses a web address, since that mistake reads like a database', () => {
    expect(() => parseDatabaseUrl('https://pos.example.com/pos_dev')).toThrow(/postgresql:\/\//);
  });

  it('refuses a URL with no database, rather than dumping nothing', () => {
    expect(() => parseDatabaseUrl('postgresql://u:p@localhost:5432/')).toThrow(/names no database/);
  });

  it('refuses a URL with no user', () => {
    expect(() => parseDatabaseUrl('postgresql://localhost/pos_dev')).toThrow(/names no user/);
  });

  it('refuses a port that is not a number', () => {
    expect(() => parseDatabaseUrl('postgresql://u:p@localhost:abc/pos_dev')).toThrow(/not a URL/);
  });
});
