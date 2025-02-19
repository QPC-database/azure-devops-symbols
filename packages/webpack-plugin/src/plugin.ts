// Only use the static one for types, so that we can use the dynamic version of webpack we get from the plugin intialization
import * as webpackTypes from "webpack";
import { ConcatSource, Source } from "webpack-sources";
import * as path from "path";
import { computeSourceMapUrlLine, sourceMapClientKeyField } from "azure-devops-symbols-sourcemap";

const pluginName = "AzureDevOpsSymbolsPlugin";

export interface AzureDevOpsSymbolsPluginOptions {
    organization: string;
}

export class AzureDevOpsSymbolsPlugin
{
    organization: string = "<Organization>";
    
    constructor(options?: AzureDevOpsSymbolsPluginOptions)
    {
        if (options) {
            this.organization = options.organization;
        }
    }

    apply(compiler: webpackTypes.Compiler) {
        // ensure proper runtime version of webpack is used below
        const { webpack, options } = compiler;

        // If we don't have source-map as a dev-tool this plugin doesn't need to do anything
        if (!options.devtool || !options.devtool.includes("source-map")) {
            return;
        }

        const hidden = options.devtool.includes("hidden");
        if (!hidden) {
            throw new Error(`When using plugin ${pluginName} you must set 'hidden' on the 'devtool' settings to true. To avoid declaring two sourcemap comments.`)
        }

        // The options we pass to extract the source map must match exactly what SourceMapDevToolPlugin
        // does internally, because else when we ask to get the sourcemap object we get a newly
        // computed one with differnt options, so when we add the extra fields, they won't be
        // in the final .js.map file
        const cheap = options.devtool.includes("cheap");
        const moduleMaps = options.devtool.includes("module");
        const sourceMapOptions = {
            module: moduleMaps ? true : cheap ? false : true,
            columns: cheap ? false : true,
        };


        compiler.hooks.compilation.tap(pluginName, 
            compilation => {

                // Register a hook just before CommonJsChunkFormatPlugin runs
                // and add field to the .js.map sourceMap file that contains the 
                // symbol client key to which the Azure DevOps symbol upload task
                // should push the symbols.
                compilation.hooks.processAssets.tapPromise(
                    {
                        name: pluginName,
                        // This should run just before the CommonJsChunkFormatPlugin runs
                        stage: webpack.Compilation.PROCESS_ASSETS_STAGE_DEV_TOOLING - 1,
                    },
                    async (assets) => {
                        for (const file of Object.keys(assets)) {
                            let asset = compilation.getAsset(file);
                            if (asset) {
                                const sourceMap = asset.source.map(sourceMapOptions);
                                if (sourceMap){
                                    
                                    // Compute the hash of the sourcefile (before appending the sourceUrl comment)
                                    const hash = compiler.webpack.util.createHash(compilation.outputOptions.hashFunction || "md4")
                                    asset.source.updateHash(hash);
                                    const clientKey = <string>hash.digest("hex");
                            
                                    // Add the sourcemap client id field to the sourcemap json object.
                                    (<any>sourceMap)[sourceMapClientKeyField] = clientKey;

                                    const sourceMapFileName = path.basename(file);
                                    const sourceMapLineToAppend = computeSourceMapUrlLine(this.organization, clientKey, sourceMapFileName);
                                    
                                    compilation.updateAsset(asset.name, x => x, (info) => Object.assign(info, {related: {sourceMapLineToAppend: sourceMapLineToAppend}}));


                                }
                            }
                        }
                    });


                    compilation.hooks.processAssets.tapPromise(
                        {
                            name: pluginName,
                            stage: webpack.Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
                            additionalAssets: true
                        },
                        async (assets) => {
                            for (const file of Object.keys(assets)) {

                                let asset = compilation.getAsset(file);
                                if (asset && asset.info.related && asset.info.related.sourceMapLineToAppend) {
                                    console.log("Adding comment");
                                    const content = <string>asset.info.related.sourceMapLineToAppend;
                                    compilation.updateAsset(
                                        file, 
                                        <any>((source: Source) => new ConcatSource(source, content)), 
                                        {}
                                    );
                                }
                            }
                        }
                );
            });
    }
}
