import { Type, type Static } from '@sinclair/typebox';

export const EmailSchema = Type.String({ format: 'email', maxLength: 254 });
export const OtpRequestSchema = Type.Object({ email: EmailSchema });
export type OtpRequest = Static<typeof OtpRequestSchema>;

export const OtpVerifySchema = Type.Object({
  challengeId: Type.String({ minLength: 10, maxLength: 100 }),
  code: Type.String({ pattern: '^\\d{6}$' }),
});
export type OtpVerify = Static<typeof OtpVerifySchema>;

export const NetworkProfileSchema = Type.Object({
  effectiveType: Type.Optional(Type.Union([
    Type.Literal('slow-2g'), Type.Literal('2g'), Type.Literal('3g'), Type.Literal('4g'), Type.Literal('unknown'),
  ])),
  downlinkMbps: Type.Optional(Type.Number({ minimum: 0, maximum: 10_000 })),
  observedUploadBps: Type.Optional(Type.Number({ minimum: 0, maximum: 10 * 1024 * 1024 * 1024 })),
}, { additionalProperties: false });

export const PrepareUploadSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  size: Type.Integer({ minimum: 1 }),
  lastModified: Type.Integer({ minimum: 0 }),
  declaredMime: Type.String({ maxLength: 200 }),
  quickFingerprint: Type.String({ minLength: 8, maxLength: 200 }),
  networkProfile: Type.Optional(NetworkProfileSchema),
});

export const DedupeVerifySchema = Type.Object({
  challengeId: Type.String({ minLength: 10, maxLength: 100 }),
  hashes: Type.Array(Type.String({ pattern: '^[a-f0-9]{64}$' }), { minItems: 1, maxItems: 8 }),
});
export type PrepareUpload = Static<typeof PrepareUploadSchema>;

export const AckPartsSchema = Type.Object({
  parts: Type.Array(Type.Object({
    partNumber: Type.Integer({ minimum: 1, maximum: 10000 }),
    etag: Type.String({ minLength: 1, maxLength: 200 }),
    size: Type.Integer({ minimum: 1 }),
  }), { minItems: 1, maxItems: 32 }),
});
