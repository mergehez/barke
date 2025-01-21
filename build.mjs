import { exec } from "child_process";
import { build } from "esbuild";
import { readFileSync } from "fs"

const pkg = JSON.parse( readFileSync( new URL('./package.json', import.meta.url) ).toString());
const external = [
    ...Object.keys(pkg.dependencies),
    ...Object.keys(pkg.peerDependencies || {})
];

await build({
    bundle: true,
    minify: false,
    platform: 'node',
    format: 'esm',
    external,
    format: 'cjs',
    target: 'node16',
    outfile: "dist/barke-yaml.cjs",
    entryPoints: ["yaml/index.ts"],
    plugins: [ 
        {
            name: "yaml_files_loader",
            setup(build) {
                build.onLoad({ filter: /barke\.(.*)\.yml$/ }, async (args) => {
                    return { loader: "text", contents: readFileSync(args.path).toString() }
                })
            }
        },
    ]
});

await build({
    bundle: true,
    minify: false,
    platform: 'node',
    format: 'esm',
    external,
    outfile: "dist/index.js",
    entryPoints: ["src/index.ts"],
    plugins: [
        {
            name: 'generate-types',
            setup(build) {
                build.onStart(() => {
                    const cmd = `
                        tsc 
                            src/index.ts
                            --outDir dist/types
                            --emitDeclarationOnly 
                            --declarationDir null
                            --noEmit false 
                            --declaration
                            --esModuleInterop
                            --types node
                            --target esnext
                            --module nodenext
                            --moduleResolution nodenext
                            --strict
                            --resolveJsonModule
                            --allowImportingTsExtensions
                    `.replace(/\s+/g, ' ');

                    console.log(cmd)
                    exec(cmd, (err, stdout, stderr) => {
                        console.log(stdout)
                        console.error(stderr)
                    });
                });
            }
        }
    ]
});