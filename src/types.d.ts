/**
 * Type declarations for modules without types
 */

declare module 'inquirer-autocomplete-prompt';
declare module '@modelcontextprotocol/sdk' {
  export class Server {
    constructor(config: any);
    setRequestHandler(event: string, handler: Function): void;
    handleRequest(message: any): Promise<any>;
  }
}