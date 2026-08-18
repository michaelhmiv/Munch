import { createHash, randomBytes } from "node:crypto";

export interface IssuedOpaqueToken {
    token: string;
    hash: Buffer;
}

export function hashOpaqueToken(token: string): Buffer {
    if (!token) {
        throw new Error("Token cannot be empty");
    }
    return createHash("sha256").update(token, "utf8").digest();
}

export function issueOpaqueToken(byteLength = 32): IssuedOpaqueToken {
    if (!Number.isInteger(byteLength) || byteLength < 24 || byteLength > 128) {
        throw new Error(
            "Token byte length must be an integer between 24 and 128",
        );
    }

    const token = randomBytes(byteLength).toString("base64url");
    return {
        token,
        hash: hashOpaqueToken(token),
    };
}
