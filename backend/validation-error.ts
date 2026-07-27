/**
 * An error caused by invalid user input or an unsafe requested operation.
 *
 * This lives outside the socket utilities so validation-focused code can be
 * tested without importing the backend's terminal and socket dependencies.
 */
export class ValidationError extends Error {
    constructor(message : string) {
        super(message);
    }
}
