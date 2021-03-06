/* jshint camelcase: false */
/* jshint newcap: false */

var _ = require('underscore');
var async = require('async');
var HttpStatus = require('http-status-codes');
var Config = require('./service');
var util = require('util');
var validCollations = require('./validCollations.json');

var sqldbProvision = function (log, params) {

    var instanceId = params.instance_id;
    var reqParams = params.parameters || {};

    var resourceGroupName = reqParams.resourceGroup || '';
    var sqldbName = reqParams.sqldbName || '';
    var sqlServerName = reqParams.sqlServerName || '';

    log.info(util.format('sqldb cmd-provision: resourceGroupName: %s, sqldbName: %s, sqlServerName: %s', resourceGroupName, sqldbName, sqlServerName));

    var location = '';
    var parametersDefined = !(_.isNull(reqParams.parameters) || _.isUndefined(reqParams.parameters));
    if (parametersDefined) {
        location = reqParams.parameters.location || '';
    }

    var firewallRuleName = '';
    var firewallRuleStartIp = '';
    var firewallRuleEndIp = '';
    if (!_.isUndefined(reqParams.sqlServerParameters)) {
        if (!_.isUndefined(reqParams.sqlServerParameters.allowSqlServerFirewallRule)) {
            firewallRuleName = reqParams.sqlServerParameters.allowSqlServerFirewallRule.ruleName;
            firewallRuleStartIp = reqParams.sqlServerParameters.allowSqlServerFirewallRule.startIpAddress;
            firewallRuleEndIp = reqParams.sqlServerParameters.allowSqlServerFirewallRule.endIpAddress;
        }
    }

    // this is to minimize the amount of static data 
    // that must be included in the developer's parameters file
    this.fixupParameters = function () {

        // patch up the sqlServerParameters
        if (_.isUndefined(params.parameters.sqlServerParameters)) {
            params.parameters.sqlServerParameters = {};
        }
        if (_.isUndefined(params.parameters.sqlServerParameters.properties)) {
            params.parameters.sqlServerParameters.properties = {};
        }
        if (!_.isUndefined(params.parameters.sqlServerParameters.allowSqlServerFirewallRule)) {
            if (!_.isString(params.parameters.sqlServerParameters.allowSqlServerFirewallRule.endIpAddress)) {
                params.parameters.sqlServerParameters.allowSqlServerFirewallRule.endIpAddress = '';
            }

            if (params.parameters.sqlServerParameters.allowSqlServerFirewallRule.endIpAddress.length === 0) {
                params.parameters.sqlServerParameters.allowSqlServerFirewallRule.endIpAddress = params.parameters.sqlServerParameters.allowSqlServerFirewallRule.beginIpAddress;
            }

            firewallRuleEndIp = params.parameters.sqlServerParameters.allowSqlServerFirewallRule.endIpAddress;
        }
        if ((params.parameters.sqlServerCreateIfNotExist || false) === false) {
            params.parameters.sqlServerCreateIfNotExist = false;
            params.parameters.sqlServerParameters.properties.administratorLogin = null;
            params.parameters.sqlServerParameters.properties.administratorLoginPassword = null;
        }
        params.parameters.sqlServerParameters.properties.version = '12.0';

        // figure out what plan they selected and fill in some properties
        var planId = params.plan_id;
        log.info('SqlDb/cmd-provision/fixup parameters/planid: %j', planId);
        Config.plans.forEach(function (item) {
            if (planId === item.id) {
                log.info('SqlDb/cmd-provision/fixup parameters/plan name: %j', item.name);
                params.parameters.sqldbParameters.properties.maxSizeBytes = item.metadata.details.maxSizeBytes;
                params.parameters.sqldbParameters.properties.createMode = item.metadata.details.createMode;
                params.parameters.sqldbParameters.properties.edition = item.metadata.details.edition;
                params.parameters.sqldbParameters.properties.requestedServiceObjectiveName = item.metadata.details.requestedServiceObjectiveName;
                //params.parameters.sqldbParameters.properties.requestedServiceObjectiveId = item.metadata.details.requestedServiceObjectiveId;
            }
        });

    };

    this.provision = function (sqldbOperations, resourceGroup, next) {

        var groupParameters = {
            location: location
        };

        async.waterfall([
            function (callback) {
                log.info('sqldb cmd-provision: async.waterfall/getToken');
                sqldbOperations.getToken(function (err, accessToken) {
                    if (err) {
                        log.error('sqldb cmd-provision: async.waterfall/getToken: err: %j', err);
                        return callback(err);
                    } else {
                        sqldbOperations.setParameters(accessToken, resourceGroupName, sqlServerName, sqldbName, firewallRuleName);
                        callback(null);
                    }
                });
            },
            function (callback) {
                log.info('sqldb cmd-provision: async.waterfall/resourceGroup.checkExistence');
                resourceGroup.checkExistence(resourceGroupName, function (err, checkExistenceResult, req, res) {
                    if (err) {
                        log.error('sqldb: resourceGroup.checkExistence: err: %j', err);
                        return callback(err);
                    } else {
                        callback(null, checkExistenceResult);
                    }
                });
            },
            function (checkExistenceResult, callback) {
                log.info('sqldb cmd-provision: async.waterfall/resourceGroup.createOrUpdate: checkExistenceResult: %j', checkExistenceResult);

                if (checkExistenceResult === false) {
                    resourceGroup.createOrUpdate(resourceGroupName, groupParameters, function (err, createRGResult, req, res) {
                        if (err) {
                            log.error('sqldb cmd-provision: async.waterfall/resourceGroup.createOrUpdate: err: %j', err);
                            return callback(err);
                        } else {
                            callback(null, createRGResult);
                        }
                    });
                } else {
                    callback(null, true);
                }
            },
            function (createRGResult, callback) {  // get sql server status (existence check)
                log.info('sqldb cmd-provision: async.waterfall/get sqlServer status: createRGResult: %j', createRGResult);

                sqldbOperations.getServer(reqParams, function (err, result) {
                    if (err) {
                        log.error('sqldb cmd-provision: async.waterfall/get the sql server: err: %j', err);
                        return callback(err);
                    } else {
                        callback(null, result);
                    }
                });
            },
            function (result, callback) {   // create sql server if not exist
                log.info('sqldb cmd-provision: async.waterfall/create sql server');
                var provisionServerIfNotExist = reqParams.sqlServerCreateIfNotExist || false;
                if (result.statusCode === HttpStatus.NOT_FOUND) {
                    if (provisionServerIfNotExist) {
                        sqldbOperations.createServer(reqParams, function (err, result) {
                            if (err) {
                                log.error('sqldb cmd-provision: async.waterfall/create the sql server: err: %j', err);
                                callback(err);
                            } else {    // sql server created, go on to create the database
                                callback(null);
                            }
                        });
                    } else {
                        callback(Error('SQL DB Server not found and no directive to create it.'));
                    }
                } else {    // sql server exists, go see if the db exists                    
                    callback(null);
                }
            },
            function (callback) {  // open firewall IP if requested
                log.info('sqldb cmd-provision: async.waterfall/allow IP through sql server firewall: rule name: %j:', firewallRuleName);
                if (firewallRuleName.length !== 0) {

                    sqldbOperations.createFirewallRule(firewallRuleStartIp, firewallRuleEndIp, function (err, result) {
                        if (err) {
                            log.error('sqldb cmd-provision: async.waterfall/create firewall rule: err: %j', err);
                            return callback(err);
                        } else if ((result.statusCode === HttpStatus.OK) || (result.statusCode === HttpStatus.CREATED)) {
                            log.info('sqldb cmd-provision: async.waterfall/create firewall rule: rule created');
                            callback(null);
                        } else {
                            log.error('sqldb cmd-provision: async.waterfall/create firewall rule, unexpected error: result: %j', result);
                            return callback(Error(result.body.message));
                        }
                    });

                } else {
                    callback(null);
                }
            },
            function (callback) {   // see if db exists (in the case that sql server was there already)
                log.info('sqldb cmd-provision: async.waterfall/check existence of database');
                sqldbOperations.getDatabase(function (err, result) {
                    if (err) {
                        log.error('sqldb cmd-provision: async.waterfall/check existence of sql database: err: %j', err);
                        callback(err);
                    } else if (result.statusCode === HttpStatus.NOT_FOUND) {
                        callback(null);
                    } else if (result.statusCode === HttpStatus.OK) {
                        callback(Error('Database already exists'));
                    } else {
                        log.error('sqldb cmd-provision: async.waterfall/check existence of sql database, unexpected error: result: %j', result);
                        callback(Error('Unexpected error.'));
                    }
                });
            },
            function (callback) {  // create the database
                log.info('sqldb cmd-provision: async.waterfall/create the database');
                sqldbOperations.createDatabase(reqParams, function (err, result) {
                    if (err) {
                        log.error('sqldb cmd-provision: async.waterfall/create sql database: err: %j', err);
                        callback(err);
                    } else {
                        log.info('sqldb cmd-provision: async.waterfall/create sql database: result: %j', result);
                        if (result.body.operation === 'CreateLogicalDatabase') {   // create provisioningResult
                            result.body.provisioningResult = 'creating';
                            result.body.sqlServerName = reqParams.sqlServerName;
                            result.body.sqldbName = reqParams.sqldbName;
                            result.body.sqldbParameters = reqParams.sqldbParameters;

                            result.value = {};
                            result.value.state = 'creating';
                            result.value.description = 'Creating logical database ' + reqParams.sqldbName + ' on logical server ' + reqParams.sqlServerName + '.';
                        }
                        callback(null, result);
                    }
                });
            }
        ], function (err, result) {
            if (err) {
                log.info('sqldb cmd-provision: async.waterfall/final callback: err: ', err);
            } else {
                log.info('sqldb cmd-provision: async.waterfall/final callback: result: ', result);
            }
            next(err, result);
        });
    };

    // validators

    this.firewallRuleIsOk = function () {
        if (!_.isUndefined(reqParams.sqlServerParameters.allowSqlServerFirewallRule)) {
            if (_.isString(reqParams.sqlServerParameters.allowSqlServerFirewallRule.ruleName)) {
                if (reqParams.sqlServerParameters.allowSqlServerFirewallRule.ruleName.length === 0) return false;
            } else return false;
            if (_.isString(reqParams.sqlServerParameters.allowSqlServerFirewallRule.startIpAddress)) {
                if (reqParams.sqlServerParameters.allowSqlServerFirewallRule.startIpAddress.length === 0) return false;
                if (reqParams.sqlServerParameters.allowSqlServerFirewallRule.startIpAddress.search('^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$') !== 0) return false;
            } else return false;
            if (_.isString(reqParams.sqlServerParameters.allowSqlServerFirewallRule.endIpAddress)) {
                if (reqParams.sqlServerParameters.allowSqlServerFirewallRule.startIpAddress.length !== 0) {
                    if (reqParams.sqlServerParameters.allowSqlServerFirewallRule.endIpAddress.search('^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$') !== 0) return false;
                }
            } else return true;
        }
        return true;    // no firewall rule at all, is ok.
    };

    this.resourceGroupWasProvided = function () {
        if (_.isString(resourceGroupName)) {
            if (resourceGroupName.length !== 0) return true;
        }
        log.error('SqlDb Provision: Resource Group name was not provided. Did you supply the parameters file?');
        return false;
    };

    this.sqlServerNameWasProvided = function () {
        if (_.isString(reqParams.sqlServerName)) {
            if (reqParams.sqlServerName.length !== 0) return true;
        }
        log.error('SqlDb Provision: SQL Server name was not provided.');
        return false;
    };

    this.sqlServerParametersWereProvided = function () {
        if ((reqParams.sqlServerCreateIfNotExist || false) === true) {
            if ((reqParams.sqlServerParameters || {}) != {}) {
                if (_.isString(reqParams.sqlServerParameters.properties.administratorLogin)) {
                    if (reqParams.sqlServerParameters.properties.administratorLogin.length === 0) return false;
                } else return false;
                if (_.isString(reqParams.sqlServerParameters.properties.administratorLoginPassword)) {
                    if (reqParams.sqlServerParameters.properties.administratorLoginPassword.length === 0) return false;
                } else return false;
                if (_.isString(reqParams.sqlServerParameters.properties.version)) {
                    if (reqParams.sqlServerParameters.properties.version !== '12.0') return false;
                } else return false;
                return true;
            }
            return false;   // this case means we need sql server parameters but none were provided
        }
        return true;    // in this case, we don't want to create the sql server so lack of parameters is correct.
    };

    this.sqlDbNameWasProvided = function () {
        if (_.isString(reqParams.sqldbName)) {
            if (reqParams.sqldbName.length !== 0) return true;
        }
        log.error('SqlDb Provision: SQL DB name was not provided.');
        return false;
    };

    this.sqlDbCollationWasProvided = function () {
        if (_.isString(reqParams.sqldbParameters.properties.collation)) {
            var collation = reqParams.sqldbParameters.properties.collation;
            if (_.indexOf(validCollations, collation) != -1) return true;
        }
        log.error('SqlDb Provision: SQL DB collation was not provided.');
        return false;
    };

    this.allValidatorsSucceed = function () {
        return this.resourceGroupWasProvided() &&
            this.sqlServerNameWasProvided() &&
            this.sqlDbNameWasProvided() &&
            this.sqlDbCollationWasProvided() &&
            this.sqlServerParametersWereProvided() &&
            this.firewallRuleIsOk();
    };
};

module.exports = sqldbProvision;
