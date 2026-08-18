import "hono";

declare module "hono" {
    interface ContextVariableMap {
        userId: string;
        accessToken: string;
        suppressAccessLog: boolean;
        munchUserId: string;
        munchUserEmail: string;
    }
}

export {};
