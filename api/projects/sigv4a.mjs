// CloudFront KeyValueStore requests must be signed with SigV4A. The SDK's multi-region signer looks
// for a SigV4A implementation in *its own* copy of @smithy/signature-v4, which npm may nest separately
// from the copy @smithy/signature-v4a registers into, so register it in the signer's copy directly.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fromClient = createRequire(require.resolve('@aws-sdk/client-cloudfront-keyvaluestore'));
const fromSigner = createRequire(fromClient.resolve('@aws-sdk/signature-v4-multi-region'));
fromSigner('@smithy/signature-v4').signatureV4aContainer.SignatureV4a = require('@smithy/signature-v4a').SignatureV4a;
