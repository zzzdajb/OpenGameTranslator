export type Result<T> = SuccessResult<T> | FailureResult;

export interface SuccessResult<T> {
    readonly isSuccess: true;
    readonly value: T;
}

export interface FailureResult {
    readonly isSuccess: false;
    readonly errorMessage: string;
}

export class Results {
    public static success<T>(value: T): Result<T> {
        return {
            isSuccess: true,
            value: value
        };
    }

    public static failure<T>(errorMessage: string): Result<T> {
        return {
            isSuccess: false,
            errorMessage: errorMessage
        };
    }
}

