/*
 * Copyright 2015 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of perseo-fe
 *
 * perseo-fe is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * perseo-fe is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with perseo-fe.
 * If not, see http://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::[contacto@tid.es]
 */
'use strict';

var util = require('util'),
    async = require('async'),
    rulesStore = require('./rulesStore'),
    config = require('../../config'),
    myutils = require('../myutils'),
    noSignal = require('./noSignal'),
    errors = {};

function postR2core(rule, callback) {
    if (rule.text) {
        var eplRule = {
                name: myutils.ruleUniqueName(rule),
                text: myutils.ruleWithContext(rule)
            },
            context = {
                name: myutils.contextName(rule),
                text: myutils.contextEPL(rule)};

        async.series([
            myutils.requestHelper.bind(null, 'post', {url: config.perseoCore.rulesURL, json: context}),
            myutils.requestHelper.bind(null, 'post', {url: config.perseoCore.rulesURL, json: eplRule}),
            function propagateRule(cb) {
                if (config.nextCore) {
                    async.series([
                        myutils.requestHelper.bind(null, 'post', {url: config.nextCore.rulesURL, json: context}),
                        myutils.requestHelper.bind(null, 'post', {url: config.nextCore.rulesURL, json: eplRule})
                    ], function(/*error*/) {
                        cb(null); // Do not propagate error
                    });
                } else {
                    cb(null);
                }
            }
        ], callback);
    } else {
        callback(null, rule);
    }
}

function delR2core(rule, callback) {
    var wholeName = myutils.ruleUniqueName(rule);
    //Now we don't know if it is EPL or N-S, it's safe to try to remove any case
    async.series([
        myutils.requestHelper.bind(null, 'del', {url: config.perseoCore.rulesURL + '/' + wholeName}),
        function propagateDel(cb) {
            if (config.nextCore) {
                myutils.requestHelper('del', { url: config.nextCore.rulesURL + '/' + wholeName}, function(/*error*/) {
                    cb(null); // Do not propagate error
                });
            } else {
                cb(null);
            }
        }
    ], callback);
}

function putR2core(rules, callback) {
    var rulesAndContexts = [];
    rules.forEach(function(rule) {
        if (rule.text) {
            rulesAndContexts.push({
                name: myutils.contextName(rule),
                text: myutils.contextEPL(rule)
            });
            rulesAndContexts.push({
                name: myutils.ruleUniqueName(rule),
                text: myutils.ruleWithContext(rule)
            });
        }
    });
    myutils.requestHelper('put', {url: config.perseoCore.rulesURL, json: rulesAndContexts}, callback);
}

module.exports = {
    FindAll: function(tenant, service, callback) {
        rulesStore.FindAll(tenant, service, function(err, data) {
            return callback(err, data);
        });
    },
    Find: function(rule, callback) {
        rulesStore.Find(rule, function(err, data) {
            return callback(err, data);
        });
    },
    Save: function(rule, callback) {
        var localError;
        if (rule.name === null || rule.name === undefined) {
            localError = new errors.MissingRuleName(JSON.stringify(rule));
            myutils.logErrorIf(localError);
            return callback(localError);
        }
        if (!rule.text && !rule.nosignal) {
            localError = new errors.EmptyRule(JSON.stringify(rule));
            myutils.logErrorIf(localError);
            return callback(localError);
        }
        async.series(
            [
                function(localCallback) {
                    rulesStore.Exists(rule, function rsSaveExistsCb(err, exists) {
                        if (err) {
                            return localCallback(err);
                        }
                        if (exists) {
                            return localCallback(new errors.RuleExists(rule.name));
                        }
                        return localCallback(err, exists);
                    });
                },
                postR2core.bind(null, rule),
                rulesStore.Save.bind(null, rule),
                function(cb) {
                    if (rule.nosignal) {
                        noSignal.AddNSRule(rule.tenant, rule.service, rule.name, rule.nosignal);
                    }
                    cb(null);
                }
            ],
            callback
        );
    },
    Remove: function(rule, callback) {
        async.series(
            [
                rulesStore.Remove.bind(null, rule),
                delR2core.bind(null, rule),
                function(cb) {
                    noSignal.DeleteNSRule(rule.tenant, rule.service, rule.name);
                    cb(null);
                }
            ],
            callback
        );
    },
    Refresh: function(callback) {
        async.waterfall(
            [
                rulesStore.FindAll,
                function(rules, cb) {
                    noSignal.RefreshAllRules(rules);
                    cb(null, rules);
                },
                putR2core
            ],
            callback
        );
    },
    Put: function(id, rule, callback) {
        var localError;
        if (rule.name === null || rule.name === undefined) {
            localError = new errors.MissingRuleName(id + ', ' + JSON.stringify(rule));
            myutils.logErrorIf(localError);
            return callback(localError);
        }
        async.series(
            [
                rulesStore.Update.bind(null, id, rule),
                delR2core.bind(null, rule),
                postR2core.bind(null, rule),
                function(cb) {
                    if (rule.nosignal) {
                        noSignal.DeleteNSRule(rule.tenant, rule.service, rule.name);
                        noSignal.AddNSRule(rule.tenant, rule.service, rule.name, rule.nosignal);
                    }
                    cb(null);
                }
            ],
            callback
        );
    }
};
/**
 * Constructors for possible errors from this module
 *
 * @type {Object}
 */
module.exports.errors = errors;

(function() {
    errors.MissingRuleName = function MissingRuleName(msg) {
        this.name = 'MISSING_RULE_NAME';
        this.message = 'missing rule name ' + msg;
        this.httpCode = 400;
    };
    errors.EmptyRule = function EmptyRule(msg) {
        this.name = 'EMPTY_RULE';
        this.message = 'empty rule, missing text or nosignal ' + msg;
        this.httpCode = 400;
    };
    errors.RuleExists = function RuleExists(msg) {
        this.name = 'EXISTING_RULE';
        this.message = 'rule exists ' + msg;
        this.httpCode = 400;
    };
    Object.keys(errors).forEach(function(element) {
        util.inherits(errors[element], Error);
    });
})();

