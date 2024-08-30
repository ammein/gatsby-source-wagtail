const { v4: uuidv4 } = require('uuid');
const { buildSchema, printSchema } = require('graphql');
const { createHttpLink } = require('@apollo/client/link/http');
const fetch = require('node-fetch');
const invariant = require('invariant');
const traverse = require('traverse');

const { NamespaceUnderFieldTransform, StripNonQueryTransform } = require('gatsby-source-graphql/transforms');
const { createSelection } = require('./utils');
const { buildHTTPExecutor } = require('@graphql-tools/executor-http');
const { schemaFromExecutor, wrapSchema, RenameTypes } = require('@graphql-tools/wrap'); // Updated import
const { mergeSchemas } = require('@graphql-tools/schema');

// Define the sourceNodes API
exports.sourceNodes = async (
    { actions, createNodeId, cache, createContentDigest },
    options
) => {
    const { addThirdPartySchema, createNode } = actions;
    const {
        url,
        typeName,
        fieldName,
        headers = {},
        fetchOptions = {},
        createLink,
        createSchema,
        refetchInterval
    } = options;

    invariant(
        typeName && typeName.length > 0,
        `gatsby-source-wagtail requires option \`typeName\` to be specified`
    );
    invariant(
        fieldName && fieldName.length > 0,
        `gatsby-source-wagtail requires option \`fieldName\` to be specified`
    );
    invariant(
        (url && url.length > 0) || createLink,
        `gatsby-source-wagtail requires either option \`url\` or \`createLink\` callback`
    );

    let link;
    if (createLink) {
        link = await createLink(options);
    } else {
        link = createHttpLink({
            uri: url,
            fetch,
            headers,
            fetchOptions
        });
    }

    let introspectionSchema;
    const cacheKey = `gatsby-source-wagtail-${typeName}-${fieldName}`;
    let sdl = await cache.get(cacheKey);

    // Cache the remote schema for performance benefit
    if (!sdl) {
        const executor = buildHTTPExecutor({
            endpoint: url,
            fetch,
            headers,
            fetchOptions
        });

        introspectionSchema = await schemaFromExecutor(executor);
        sdl = printSchema(introspectionSchema);
        await cache.set(cacheKey, sdl);
    } else {
        introspectionSchema = buildSchema(sdl);
    }

    // Directly use the fetched schema for remote operations
    const remoteSchema = introspectionSchema;

    // Create a node for the schema
    const nodeId = createNodeId(`gatsby-source-wagtail-${typeName}`);
    const node = createSchemaNode({
        id: nodeId,
        typeName,
        fieldName,
        createContentDigest
    });
    createNode(node);

    const resolver = (parent, args, context) => {
        context.nodeModel.createPageDependency({
            path: context.path,
            nodeId: nodeId
        });
        return {};
    };

    // Add some customization of the remote schema
    const transforms = [
        new StripNonQueryTransform(),
        new NamespaceUnderFieldTransform({
            typeName,
            fieldName,
            resolver
        }),
        new WagtailRequestTransformer()
    ];

    if (options.prefixTypename) {
        transforms.unshift(new RenameTypes(name => `${typeName}_${name}`));
    }

    const mergeLocalAndRemoteSchema = async () => {
        // Merge the schema along with custom resolvers
        const schema = mergeSchemas({
            schemas: [remoteSchema],
            typeDefs: /* GraphQL */ `
                type Query {
                    _empty: String
                }
            `,
            resolvers: {
                Query: {
                    _empty: () => 'Empty resolver'
                }
            }
        });

        // Apply any transforms
        return wrapSchema({
            schema,
            transforms,
        });
    };

    // Add new merged schema to Gatsby
    addThirdPartySchema({
        schema: await mergeLocalAndRemoteSchema()
    });

    // Allow refreshing of the remote data in DEV mode only
    if (process.env.NODE_ENV !== 'production') {
        if (refetchInterval) {
            const msRefetchInterval = refetchInterval * 1000;
            const refetcher = () => {
                createNode(
                    createSchemaNode({
                        id: nodeId,
                        typeName,
                        fieldName,
                        createContentDigest
                    })
                );
                setTimeout(refetcher, msRefetchInterval);
            };
            setTimeout(refetcher, msRefetchInterval);
        }
    }
};

// Function to create a schema node with a unique type name
function createSchemaNode({ id, typeName, fieldName, createContentDigest }) {
    const nodeContent = uuidv4();
    const nodeContentDigest = createContentDigest(nodeContent);
    return {
        id,
        typeName,
        fieldName,
        parent: null,
        children: [],
        internal: {
            type: `${typeName}GraphQLSource`, // Updated to use a unique type name
            contentDigest: nodeContentDigest,
            ignoreType: true
        }
    };
}


// WagtailRequestTransformer class
class WagtailRequestTransformer {
    transformSchema = schema => schema;

    transformRequest = request => {
        for (let node of traverse(request.document.definitions).nodes()) {
            if (
                node?.kind === 'Field' &&
                node?.selectionSet?.selections?.find(
                    selection => selection?.name?.value === 'imageFile'
                )
            ) {
                // Add field to AST
                const createSelection = name => ({
                    kind: 'Field',
                    name: {
                        kind: 'Name',
                        value: name
                    },
                    arguments: [],
                    directives: []
                });
                // Make sure we have src, height & width details
                node.selectionSet.selections.push(createSelection('id'));
                node.selectionSet.selections.push(createSelection('src'));
                // Break as we don't need to visit any other nodes
                break;
            }
        }

        return request;
    };

    transformResult = result => result;
}
