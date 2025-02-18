import querystring from 'querystring';
import url from 'url';

import type {AxiosRequestConfig} from 'axios';
import _ from 'lodash';
import {v4 as uuidv4} from 'uuid';

import {
    DEFAULT_LANG_HEADER,
    DEFAULT_PROXY_HEADERS,
    ECMA_STRING_SIZE,
    Lang,
    VERSION,
} from '../constants';
import {
    ApiActionConfig,
    ApiServiceRestActionConfig,
    EndpointsConfig,
    GatewayApiOptions,
    GatewayError,
    Headers,
    ParamsOutput,
    ResponseError,
    Stats,
} from '../models/common';
import {GatewayContext} from '../models/context';
import {AppErrorConstructor} from '../models/error';
import {getAxiosClient} from '../utils/axios';
import {
    handleError,
    isExtendedActionEndpoint,
    isExtendedRestActionEndpoint,
    sanitizeDebugHeaders,
} from '../utils/common';
import {parseRestError} from '../utils/parse-error';
import {redactSensitiveHeaders} from '../utils/redact-sensitive-headers';
import {encodePathParams, getPathArgsProxy, validateArgs} from '../utils/validate';

function getRestResponseSize<Context extends GatewayContext>(
    data: unknown,
    ctx: Context,
    ErrorConstructor: AppErrorConstructor,
) {
    let responseSize = 0;
    try {
        responseSize = ECMA_STRING_SIZE * JSON.stringify(data)?.length;
    } catch (error) {
        handleError(ErrorConstructor, error, ctx, 'Calculate response size failed');
    }

    return responseSize;
}

function getConfigSerializerFunction(config: ApiServiceRestActionConfig<any, any, any>) {
    if (typeof config.paramsSerializer === 'function') {
        return config.paramsSerializer;
    }
    if (config.paramsSerializer && 'serialize' in config.paramsSerializer) {
        return config.paramsSerializer.serialize;
    }
    return undefined;
}

export default function createRestAction<Context extends GatewayContext>(
    endpoints: EndpointsConfig | undefined,
    config: ApiServiceRestActionConfig<Context, any, any>,
    serviceKey: string,
    actionName: string,
    options: GatewayApiOptions<Context>,
    ErrorConstructor: AppErrorConstructor,
) {
    const timeout = config?.timeout ?? options?.timeout;
    const defaultAxiosClient = getAxiosClient(timeout, config?.retries, options?.axiosConfig);

    /* eslint-disable complexity */
    return async function action(
        actionConfig: ApiActionConfig<Context, any>,
    ): Promise<{responseData: unknown; debugHeaders: Headers}> {
        const {args, requestId, headers: requestHeaders, ctx: parentCtx, authArgs} = actionConfig;
        const debugHeaders: Headers = {};
        const lang = requestHeaders[DEFAULT_LANG_HEADER] || Lang.Ru; // header might be empty string
        const serviceName = options?.serviceName || serviceKey;
        const idempotency = config.idempotency;

        const ctx = parentCtx.create(`Gateway ${serviceName} ${actionName} [rest]`, {
            tags: {
                action: actionName,
                service: serviceName,
                type: 'rest',
            },
        });
        ctx.log('Initiating request');

        const validationSchema = config.validationSchema || options.validationSchema;
        if (validationSchema) {
            const invalidParams = validateArgs(args, validationSchema);

            if (invalidParams) {
                ctx.log('Invalid params', {invalidParams});
                ctx.end();

                return Promise.reject({
                    error: {
                        status: 400,
                        message: 'Validation failed',
                        code: 'INVALID_PARAMS',
                        details: {
                            title: 'Invalid params',
                            description: invalidParams,
                        },
                    },
                    debugHeaders,
                });
            }
        }

        let endpointData = endpoints?.endpoint;

        if (typeof config.endpoint === 'function') {
            endpointData = config.endpoint(endpoints, args);
        } else if (config.endpoint) {
            endpointData = _.get(endpoints, [config.endpoint]);
        }

        if (!endpointData) {
            const errorText = `Gateway config error. Endpoint has been not found in service "${serviceKey}"`;
            ctx.log(errorText, {serviceName, actionName});
            ctx.end();

            return Promise.reject({
                error: {
                    status: 400,
                    code: 'ENDPOINT_NOT_FOUND',
                    message: errorText,
                },
            });
        }

        const actionEndpoint = isExtendedActionEndpoint(endpointData)
            ? endpointData.path
            : endpointData;
        const endpointAxiosConfig = isExtendedRestActionEndpoint(endpointData)
            ? endpointData.axiosConfig || {}
            : {};

        const pathArgs = config.validationSchema
            ? encodePathParams(args)
            : getPathArgsProxy(args, options.encodePathArgs);
        const actionPath = typeof config.path === 'function' ? config.path(pathArgs) : config.path;
        const actionURL = actionEndpoint + actionPath;
        const parsedActionURL = url.parse(actionURL);
        const proxyHeaders = [...DEFAULT_PROXY_HEADERS];

        let actionHeaders: Headers = {
            // It's important not to lose the port in HOST header
            host: parsedActionURL.host ?? undefined,
            accept: 'application/json, */*',
            'accept-encoding': 'gzip, deflate',
            'accept-language': lang,
            'x-gateway-version': VERSION,
        };

        if (typeof options.proxyHeaders === 'function') {
            Object.assign(actionHeaders, options.proxyHeaders({...requestHeaders}, 'rest'));
        } else if (Array.isArray(options.proxyHeaders)) {
            proxyHeaders.push(...options.proxyHeaders);
        }

        if (typeof config.proxyHeaders === 'function') {
            Object.assign(actionHeaders, config.proxyHeaders({...requestHeaders}, 'rest'));
        } else if (Array.isArray(config.proxyHeaders)) {
            proxyHeaders.push(...config.proxyHeaders);
        }

        for (const headerName of proxyHeaders) {
            if (actionHeaders[headerName] === undefined) {
                actionHeaders[headerName] = requestHeaders[headerName];
            }
        }

        if (requestId) {
            actionHeaders['x-request-id'] = requestId;
        }

        if (idempotency) {
            actionHeaders['idempotency-key'] = requestHeaders['idempotency-key'] || uuidv4();
        }

        const authHeaders = (config.getAuthHeaders ?? options.getAuthHeaders)({
            actionType: 'rest',
            serviceName,
            requestHeaders,
            authArgs,
        });
        Object.assign(actionHeaders, authHeaders);

        actionHeaders = _.omitBy(actionHeaders, _.isUndefined);

        let params: ParamsOutput | undefined;

        if (config.params) {
            try {
                params = await config.params(args, actionHeaders, {ctx});
            } catch (error) {
                handleError(ErrorConstructor, error, ctx, 'Getting config params failed');
            }
        }

        const {body = undefined, query = undefined, headers = actionHeaders} = params ?? {};

        let requestBody;
        const serializer = getConfigSerializerFunction(config);
        const preparedQuery =
            serializer && query ? serializer(query) : querystring.stringify(query);
        const requestUrl = actionURL + (query ? '?' + preparedQuery : '');

        try {
            let encodedRequestBody = '';
            if (body instanceof Buffer) {
                encodedRequestBody = '[Buffer]';
            } else {
                encodedRequestBody = encodeURIComponent(
                    typeof body === 'object' ? JSON.stringify(body) : String(body),
                );
            }

            if (encodedRequestBody.length < 256) {
                requestBody = encodedRequestBody;
            }
        } catch (error) {
            handleError(ErrorConstructor, error, ctx, 'Stringify request body failed');
        }

        Object.assign(debugHeaders, {
            'x-api-request-method': config.method,
            'x-api-request-url': requestUrl,
            'x-api-request-body': requestBody ? requestBody : null,
            'x-api-request-lang': lang,
            'x-request-id': requestId,
            'x-gateway-version': VERSION,
        });

        if (headers['content-type']) {
            debugHeaders['x-api-content-type'] = headers['content-type'];
        }

        const startRequestTime = Date.now();

        let axiosClient = defaultAxiosClient;

        if (actionConfig.timeout || endpointAxiosConfig) {
            const customActionTimeout =
                actionConfig.timeout ?? config.timeout ?? endpointAxiosConfig.timeout ?? timeout;
            const customActionAxiosConfig = {
                ...(options?.axiosConfig || {}),
                ...(endpointAxiosConfig || {}),
            };
            axiosClient = getAxiosClient(
                customActionTimeout,
                config?.retries,
                customActionAxiosConfig,
            );
        }

        ctx.log('Starting request', {debugHeaders: sanitizeDebugHeaders(debugHeaders)});

        const requestData: Record<string, string | number> = {
            timestamp: startRequestTime,
            service: serviceName,
            action: actionName,
            requestId,
            requestMethod: config.method,
            requestUrl: actionURL,
        };

        const requestConfig: AxiosRequestConfig = {
            url: actionURL,
            method: config.method,
            data: body,
            params: query,
            headers: ctx ? {...ctx.getMetadata(), ...headers} : headers,
            maxRedirects: config.maxRedirects,
        };

        if (config.paramsSerializer) {
            Object.assign(requestConfig, {
                paramsSerializer: config.paramsSerializer,
            });
        }

        try {
            const response = await axiosClient.request(requestConfig);

            const endRequestTime = Date.now();
            requestData.requestTime = endRequestTime - startRequestTime;

            if (config.transformResponseData) {
                try {
                    response.data = await config.transformResponseData(response.data, {
                        args,
                        ctx,
                        headers: response.headers,
                    });

                    ctx.log('Transformed response data');
                } catch (error) {
                    handleError(ErrorConstructor, error, ctx, 'Transform response data failed');
                }
            }

            if (options?.sendStats) {
                options.sendStats(
                    {
                        ...requestData,
                        responseSize: getRestResponseSize(response?.data, ctx, ErrorConstructor),
                        restStatus: 200,
                    } as Stats,
                    redactSensitiveHeaders(parentCtx, headers),
                    parentCtx,
                    {debugHeaders: sanitizeDebugHeaders(debugHeaders)},
                );
            } else {
                ctx.stats({
                    ...requestData,
                    responseStatus: 200,
                });
            }

            ctx.log('Request completed', {debugHeaders: sanitizeDebugHeaders(debugHeaders)});
            ctx.end();

            return {responseData: response.data, debugHeaders};
        } catch (error) {
            let parsedError;

            const endRequestTime = new Date().getTime();
            requestData.requestTime = endRequestTime - startRequestTime;

            if (
                error &&
                error instanceof Object &&
                'response' in error &&
                config.transformResponseError
            ) {
                try {
                    parsedError = await config.transformResponseError(
                        error.response as ResponseError,
                        {
                            args,
                            ctx,
                        },
                    );

                    ctx.log('Transformed response error');
                } catch (error) {
                    handleError(ErrorConstructor, error, ctx, 'Transform response error failed');
                }
            }

            if (!parsedError) {
                try {
                    parsedError = parseRestError(error, lang);
                } catch (error) {
                    handleError(ErrorConstructor, error, ctx, 'Error parse rest error');
                }
            }

            const responseStatus = _.get(parsedError, 'status') || _.get(error, 'status', 500);

            if (options?.sendStats) {
                options.sendStats(
                    {
                        ...requestData,
                        responseSize: getRestResponseSize(
                            (error as any)?.response?.data,
                            ctx,
                            ErrorConstructor,
                        ),
                        restStatus: responseStatus,
                    } as Stats,
                    redactSensitiveHeaders(parentCtx, headers),
                    parentCtx,
                    {debugHeaders: sanitizeDebugHeaders(debugHeaders)},
                );
            } else {
                ctx.stats({
                    ...requestData,
                    responseStatus,
                });
            }

            ctx.logError('Request failed', error, {
                actionURL,
                parsedError,
                serviceName,
                debugHeaders: sanitizeDebugHeaders(debugHeaders),
            });
            ctx.end();

            return Promise.reject({
                error: {...parsedError, requestId} as GatewayError,
                debugHeaders,
            });
        }
    };
}
