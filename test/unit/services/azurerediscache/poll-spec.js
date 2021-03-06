/*
  good instanceId : b259c5e0-7442-46bc-970c-9912613077dd
  test: curl http://localhost:5001/v2/service_instances/62cb3099-a468-42f0-b2c2-110fe3d86611/last_operation -u demouser:demopassword -H "X-Broker-API-Version: 2.8" -H "Content-Type: application/json" -v
*/

/* jshint camelcase: false */
/* jshint newcap: false */
/* global describe, before, it */

var _ = require('underscore');
var logule = require('logule');
var should = require('should');
var sinon = require('sinon');
var cmdPoll = require('../../../../lib/services/azurerediscache/cmd-poll');
var redisClient = require('../../../../lib/services/azurerediscache/client');

var log = logule.init(module, 'RedisCache-Mocha');

var azure = {
    environment: 'AzureCloud',
    subscription_id: '743fxxxx-83xx-46xx-xx2d-xxxxb953952d',
    tenant_id: '72xxxxbf-8xxx-xxxf-9xxb-2d7cxxxxdb47',
    client_id: 'd8xxxx18-xx4a-4xx9-89xx-9be0bfecxxxx',
    client_secret: '2/DzYYYYYYYYYYsAvXXXXXXXXXXQ0EL7WPxEXX115Go=',
};
  
describe('RedisCache - Poll - PreConditions', function() {
    var validParams;
        
    before(function() {
       
        validParams = {
            instance_id : 'b259c5e0-7442-46bc-970c-9912613077dd',
            parameters : {
                resourceGroup: 'redisResourceGroup',
                cacheName: 'C0CacheNC'
            },
            provisioning_result: '{\"provisioningState\":\"Creating\"}',
            last_operation : "provision",
        };
        validParams.azure = azure;
    });
    
    describe('Poll should succeed if ...', function() {
        it('all validators succeed', function(done) {
            var cp = new cmdPoll(log, validParams);
            (cp.allValidatorsSucceed()).should.equal(true);
            done();        
        });
        
    });
});

describe('RedisCache - Poll - Execution - Cache that exists', function() {
    var validParams;
        
    before(function() {
        validParams = {
            instance_id : 'b259c5e0-7442-46bc-970c-9912613077dd',
            parameters : {
                resourceGroup: 'redisResourceGroup',
                cacheName: 'C0CacheNC'
            },
            provisioning_result: '{\"provisioningState\":\"Creating\"}'
        };
        validParams.azure = azure;
    });
    
    after(function() {
        redisClient.poll.restore();
    });
    
    describe('Poll operation outcomes should be...', function() {
        it('should output provisioningState = Succeeded', function(done) {

            var cp = new cmdPoll(log, validParams);
            (cp.allValidatorsSucceed()).should.equal(true);
            
            sinon.stub(redisClient, 'poll').yields(null, {provisioningState : 'Succeeded'});
            cp.poll(redisClient, function(err, result) {
                should.not.exist(err);
                result.statusCode.should.equal(200);
                done();        
            });
            
        });
    });
});
