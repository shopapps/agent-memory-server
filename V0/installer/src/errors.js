export class InstallerError extends Error {
  constructor(code, message, hint = undefined, details = undefined) {
    super(message);
    this.name = "InstallerError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

export function asInstallerError(error) {
  if (error instanceof InstallerError) {
    return error;
  }

  return new InstallerError(
    "E_UNEXPECTED",
    error instanceof Error ? error.message : String(error),
    "Run the doctor command for more detail.",
  );
}
