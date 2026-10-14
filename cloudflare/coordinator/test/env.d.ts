declare module '*.sql?raw' { const value: string; export default value; }
declare module '*.json?raw' { const value: string; export default value; }
declare module '*.txt?raw' { const value: string; export default value; }
declare module 'cloudflare:workers' { interface ProvidedEnv extends Env {} }
