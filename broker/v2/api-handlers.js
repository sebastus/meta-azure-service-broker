/*
 * Cloud Foundry Services Connector
 * Copyright (c) 2014 ActiveState Software Inc. All rights reserved.
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 */

/********************************/
/* Broker V2 API HTTP handlers */
/********************************/
'use strict';

var Async = require('async');
var Restify = require('restify');

var Handlers = {};

/**
 * Handles an invalid HTTP basic auth request from the CC
 * @param {Object} req the restify request
 */
Handlers.handleInvalidAuth = function (broker, req, res, next) {
    var err = 'Invalid auth credentials for provision request: ' + req.headers;
    broker.log.error(err);
    return next(new Restify.NotAuthorizedError(err));
};

/**
 * This is authentication middleware supplied to restify by the broker.
 *
 * @param {BrokerV2} broker the broker instance
 */
Handlers.authenticate = function (broker) {
    return function (req, res, next) {
        if (broker.opts.authUser || broker.opts.authPassword) {
            if (req.authorization.basic && req.authorization.basic.username === broker.opts.authUser && req.authorization.basic.password === broker.opts.authPassword) {
                return next();
            } else {
                res.status(401);
                res.setHeader('Connection', 'close');
                res.end();
                return next(new Restify.NotAuthorizedError());
            }
        } else {
            return next();
        }
    };
};

/**
 * Logs debug request headers / params
 * @param {BrokerV2} broker the broker instance
 * @param {Object} req restify request object
 * @param {Object} res restify response object
 */
Handlers.debugRequest = function (broker, req, res) {
    broker.log.debug(req.params);
    broker.log.debug(req.headers);
};

/**
 * Returns a complete service catalog listing to the CC.
 * @param {BrokerV2} broker the broker instance
 * @param {Object} req restify request object
 * @param {Object} res restify response object
 */
Handlers.handleCatalogRequest = function (broker, req, res, next) {
    broker.log.info('Processing catalog request from ' + req.connection.remoteAddress + ':' + req.connection.remotePort);

    var processResponse = function (reply) {
        reply = reply || {
            services: null,
        };

        var missingServiceOpts = [];
        var requiredServiceOpts = {
            plans: Object
        };

        if (!reply.services) {
            return next(new Error('"service" options key not supplied to the broker'));
        }

        for (var sopt in requiredServiceOpts) {
		for (var service in reply.services[service]) {
		if (!reply.services[service].hasOwnProperty(sopt)) {
                    missingServiceOpts.push(sopt);
                }
            }
        }

        if (missingServiceOpts.length > 0) {
            return next(new Error('Missing service options: ' + missingServiceOpts.join(', ')));
        }

        res.send(reply);
    };

    if (broker.listeners('catalog').length > 0) {
        broker.emit('catalog', req, processResponse);
    } else {
        broker.log.error('No listeners attached for the "catalog" event');
        return next(new Error('Provisioning not implemented on this broker. ' + req.params.version));
    }
    next();
};

/**
 * Handles new service provisioning requests
 *
 * @this {RestifyServer}
 * @param {BrokerV2} broker the broker instance
 * @param {Object} req restify request object
 * @param {Object} res restify response object
 * @callback {Function} restify's next() handler
 */
Handlers.handleProvisionRequest = function (broker, req, res, next) {

    broker.log.info('Processing provision request ' + req.params.id + ' from ' + req.connection.remoteAddress + ':' + req.connection.remotePort);

    var requiredParams = ['space_guid', 'organization_guid', 'service_id', 'id'];
    var missingOpts = [];
    for (var p in requiredParams) {
        if (!req.params.hasOwnProperty(requiredParams[p])) {
            missingOpts.push(requiredParams[p]);
        }
    }

    if (missingOpts.length > 0) {
        var msg = 'Provision request is missing the options: ' + missingOpts;
        broker.log.warn(msg);
        return next(Restify.MissingParameterError(msg));
    }

    var processResponse = function (reply) {
        reply = reply || {
            dashboard_url: null,
        };

        if (reply.exists) {
            res.status(409);
            next();
        } else {
            res.status(201);
            res.send(reply);
            Async.series([
                function (done) {
                    broker.db.provision(req, reply, done);
                },
                function (done) {
                     broker.db.getAllInstances(function (err, instances) {
                        broker.log.info('There are now ' + instances.length + ' services registered to this node');
                        broker.log.info('%j', instances);
                        done(err);
                    });
                }
            ], next);
        }
    };

    if (broker.listeners('provision').length > 0) {
        broker.emit('provision', req, processResponse);
    } else {
        broker.log.error('No listeners attached for the "provision" event');
        return next(new Error('Provisioning not implemented on this broker. ' + req.params.version));
    }
};

/**
 * Handles new service polling requests
 *
 * @this {RestifyServer}
 * @param {BrokerV2} broker the broker instance
 * @param {Object} req restify request object
 * @param {Object} res restify response object
 * @callback {Function} restify's next() handler
 */
Handlers.handlePollRequest = function (broker, req, res, next) {

    broker.log.info('%j', req.params)
    broker.log.info('Processing poll request ' + req.params.id + ' from ' + req.connection.remoteAddress + ':' + req.connection.remotePort);

    var processResponse = function (reply) {
        reply = reply || {};
        res.send(reply);
    };

    if (broker.listeners('poll').length > 0) {
        broker.emit('poll', req, processResponse);
    } else {
        broker.log.error('No listeners attached for the "poll" event');
        return next(new Error('Polling not implemented on this broker. ' + req.params.version));
    }
};

/**
 * Handles service deprovisioning requests
 *
 * The Cloud Controller expects only a 200 OK response and nothing in
 * the response body is interpreted by it.
 *
 * @this {RestifyServer}
 * @param {BrokerV2} broker the broker instance
 * @param {Object} req restify request object
 * @param {Object} res restify response object
 * @callback {Function} restify's next() handler
 */
Handlers.handleDeProvisionRequest = function (broker, req, res, next) {

    if (!req.params.id) {
        var errMsg = 'Discarding deprovision request from the cloud controller  - missing "id" parameter';
        broker.log.warn(errMsg);
        return next(errMsg);
    }

    broker.log.info('Deprovision request for service instance ' + req.params.id + ' from ' + req.connection.remoteAddress + ':' + req.connection.remotePort);

    var processResponse = function (reply) {
        reply = reply || {};

        if (reply.doesNotExist) {
            res.status(410);
        }

        Async.series([
            function (done) {
                broker.db.deprovision(req, reply, done);
            },
            function (done) {
                 broker.db.getAllInstances(function (err, instances) {
                    broker.log.info('There are now ' + instances.length + ' services registered to this node');
                    done(err);
                });
            }, function (done) {
                res.send(reply);
                done();
            }
        ], next);
    };

    if (broker.listeners('deprovision').length > 0) {
        broker.emit('deprovision', req, processResponse);
    } else {
        broker.log.error('No listeners attached for the "deprovision" event');
        return next(new Error('Deprovisioning not implemented on this broker. ' + req.params.version));
    }
};

/**
 * handles new service binding requests
 *
 * @this {restifyserver}
 * @param {BrokerV2} broker the broker instance
 * @param {object} req restify request object
 * @param {object} res restify response object
 * @callback {function} restify's next() handler
 */
Handlers.handleBindRequest = function (broker, req, res, next) {
    broker.log.info('Bind request ' + req.params.id + ' for service instance ' + req.params.instance_id + ' from ' + req.connection.remoteAddress + ':' + req.connection.remotePort);

    var processResponse = function (reply) {
        reply = reply || {};

        if (!reply.credentials) {
            broker.log.error('Cannot reply to bind request without the "credentials" field supplied');
            res.status(500);
            return next(new Error('Internal error'));
        }

        res.status(201);
        res.send(reply);
        broker.db.bind(req, reply, next);
    };


    if (broker.listeners('bind').length > 0) {
        broker.emit('bind', req, processResponse);
    } else {
        broker.log.error('No listeners attached for the "bind" event');
        return next(new Error('Binding not implemented on this broker. ' + req.params.version));
    }
};

/**
 * handles service unbinding requests
 *
 * @this {restifyserver}
 * @param {BrokerV2} broker the broker instance
 * @param {object} req restify request object
 * @param {object} res restify response object
 * @callback {function} restify's next() handler
 */
Handlers.handleUnbindRequest = function(broker, req, res, next) {
    broker.log.info('Unbind request ' + req.params.id + ' for service instance ' + req.params.instance_id + ' from ' + req.connection.remoteAddress + ':' + req.connection.remotePort);

    var processResponse = function (reply) {
        reply = reply || {};
        res.status(200);
        res.send(reply);
        broker.db.unbind(req, reply, next);
    };

    if (broker.listeners('unbind').length > 0) {
        broker.emit('unbind', req, processResponse);
    } else {
        broker.log.error('No listeners attached for the "unbind" event');
        return next(new Error('Unbinding not implemented on this broker. ' + req.params.version));
    }
};

module.exports = Handlers;