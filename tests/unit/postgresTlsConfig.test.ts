import { describe, expect, it } from 'vitest';
import { postgresConnectionConfig, postgresTlsConfig } from '../../src/persistence/postgresStore';

describe('PostgreSQL TLS configuration', () => {
  it('uses the supplied CA with hostname verification enabled', () => {
    expect(postgresTlsConfig(
      'postgresql://user:pass@db.example.com:25060/app?sslmode=verify-full',
      '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----',
    )).toEqual({
      ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
      rejectUnauthorized: true,
    });
  });

  it('does not invent a CA and rejects contradictory disable-plus-CA settings', () => {
    expect(postgresTlsConfig('postgresql://localhost/app', undefined)).toBeUndefined();
    expect(() => postgresTlsConfig(
      'postgresql://db.example.com/app?sslmode=disable',
      'certificate',
    )).toThrow(/sslmode=disable/i);
  });

  it.each(['ssl', 'sslrootcert', 'sslcert', 'sslkey'])(
    'rejects a conflicting %s URL option when an explicit CA is supplied',
    (parameter) => {
      expect(() => postgresConnectionConfig(
        `postgresql://db.example.com/app?${parameter}=conflict`,
        'certificate',
      )).toThrow(new RegExp(parameter, 'i'));
    },
  );

  it('removes URL TLS parameters so node-postgres cannot overwrite the verified CA', () => {
    expect(postgresConnectionConfig(
      'postgresql://user:pass@db.example.com:25060/app?application_name=review-yeti&sslmode=verify-full',
      '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
    )).toEqual({
      connectionString: 'postgresql://user:pass@db.example.com:25060/app?application_name=review-yeti',
      ssl: {
        ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
        rejectUnauthorized: true,
      },
    });
  });
});
