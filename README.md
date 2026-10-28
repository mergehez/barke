[![NPM Version](https://img.shields.io/npm/v/%40mergehez%2Fbarke)](https://www.npmjs.com/package/@mergehez/barke)
![NPM Downloads](https://img.shields.io/npm/d18m/%40mergehez%2Fbarke)



# Barke

An automation utilities library for deployment and other repetitive tasks.

I built it for myself but now we are using it in our company as well. It is useful for deployment. It has some predefined methods like "findNewFiles". This example method finds files inside your remote folder, compares them with the local ones and gives you a list of modified files. You can then use the predefined method "uploadFiles" to upload these files to the server.

For all available predefined methods check the code.

# Installation
```bash
bun add @mergehez/barke
```
*or with any other package manager like 'npm'*:
```bash
npm i @mergehez/barke
```

# Library usage (Example)

```typescript
import { useExecuter } from "./src/index.ts";

const executer = useExecuter({
    targetOS: 'windows',
    sourceBasePath: './bin/publish',
    targetBasePath: 'C:/inetpub/wwwroot/mysite',
});

const sshConn = await executer.sshConnect({
    host: process.env.WIN_SERVER_HOST,
    username: process.env.WIN_SSH_USERNAME,
    password: process.env.WIN_SSH_PASSWORD,
    port: parseInt(process.env.WIN_SSH_PORT),
});
const iis = executer.useIISHelpers(sshConn);

// STEPS:
executer.exec({
    command: 'dotnet publish -c Staging -r win-x86 -f net9.0 -o "./bin/publish"',
    message: 'Building project...',
})
const newFiles = await sshConn.findNewFiles({
    ignorePatterns: [
        '/toIgnore',
        '*.txt',
    ],
    ignoreFn: (path, stats) => {
        return !stats.isDirectory() && !path.includes('/');
    }
});

const zip = executer.compressFiles(newFiles, [
    'MailTemplates', // print like 'MailTemplates/**'
]);

await sshConn.uploadFile(zip.path);
iis.stopSite('mysite', 'mysite');
await zip.unzipOnServer(sshConn);
await zip.deleteOnServer(sshConn);
iis.startSite('mysite', 'mysite');
zip.deleteLocally();

sshConn.dispose();
executer.finish();
```

