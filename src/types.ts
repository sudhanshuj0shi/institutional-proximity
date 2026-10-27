export interface EditorSession {
  id: number;
  username: string;
  displayName: string;
  roles: string[];
  isHuman: boolean;
  csrf: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      editor: EditorSession | null;
    }
  }
}
