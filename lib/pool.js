var bignum = require('bignum');
var events = require('events');
var async = require('async');

var varDiff = require('./varDiff.js');
var daemon = require('./daemon.js');
var peer = require('./peer.js');
var stratum = require('./stratum.js');
var jobManager = require('./jobManager.js');
var util = require('./util.js');

/*process.on('uncaughtException', function(err) {
    console.log(err.stack);
    throw err;
});*/

var pool = module.exports = function pool(options, authorizeFn){

    this.options = options;

    var _this = this;
    var blockPollingIntervalId;


    var emitLog        = function(text) { _this.emit('log', 'debug'  , text); };
    var emitInfoLog    = function(text) { _this.emit('log', 'info'   , text); };
    var emitWarningLog = function(text) { _this.emit('log', 'warning', text); };
    var emitErrorLog   = function(text) { _this.emit('log', 'error'  , text); };
    var emitSpecialLog = function(text) { _this.emit('log', 'special', text); };



    if (!(options.coin.algorithm in algos)){
        emitErrorLog('The ' + options.coin.algorithm + ' hashing algorithm is not supported.');
        throw new Error();
    }



    this.start = function(){
        SetupVarDiff();
        SetupApi();
        SetupDaemonInterfaces(function(){
            DetectCoinData(function(){
                SetupRecipients();
                SetupJobManager();
                OnBlockchainSynced(function(){
                    GetFirstJob(function(){
                        SetupBlockPolling();
                        SetupPeer();
                        StartStratumServer(function(){
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };

    function UpdateAuxes(finishedCallback) {
        if(!finishedCallback)
            finishedCallback = function() {};
        var indexes = [];
        if(options.auxes) {
          for(var i = 0;i < options.auxes.length;i++) indexes.push(i);
        } // or make sure options.auxes always exists, even if empty. This seems cleaner.
        _this.updateNeeded = false;
        async.each(indexes, GetAuxWork, function(err) {
            if(err) emitErrorLog('could not update auxillary chains: ' + err);
                if(_this.updateNeeded) {
                    GetBlockTemplate(function() {
                        if (indexes.length > 0){
                            for(var i = 0;i < indexes.length;i++) {
                                emitLog('added updating work for auxillary chains ' + options.auxes[i].coin.name);
                            }
                        } else {
                            emitLog('added updating work for auxillary chains ' + options.auxes[0].coin.name);
                        }
                    }, true);
                }
            finishedCallback();
        });
    }

    function GetFirstJob(finishedCallback){
        // Get work from auxillary chains every 5 seconds, perpetually
        UpdateAuxes(function() {
            GetBlockTemplate(function(error, result){
                if (error) {
                    emitErrorLog('Error with getblocktemplate on creating first job, server cannot start');
                    return;
                }

                var portWarnings = [];

                var networkDiffAdjusted = options.initStats.difficulty;

                Object.keys(options.ports).forEach(function(port){
                    var portDiff = options.ports[port].diff;
                    if (networkDiffAdjusted < portDiff)
                        portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
                });

                //Only let the first fork show synced status or the log wil look flooded with it
                if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                    var warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than ' + portWarnings.join(' and ');
                    emitWarningLog(warnMessage);
                }
                setInterval(UpdateAuxes, 5000);
                finishedCallback();
            });
        });
    }


    function OutputPoolInfo(){

        var startMessage = 'started for ' + options.coin.name +
            ' [' + options.coin.symbol.toUpperCase() + '] {' + options.coin.algorithm + '}';
        if (process.env.forkId && process.env.forkId !== '0'){
            emitLog(startMessage);
            return;
        }
        var infoLines = [startMessage,
                'Network Connected:\t' + (options.testnet ? 'Testnet' : 'Mainnet'),
                'Detected Reward Type:\t' + options.coin.reward,
                'Current Block Height:\t' + _this.jobManager.currentJob.rpcData.height,
                'Current Connect Peers:\t' + options.initStats.connections,
                'Current Block Diff:\t' + _this.jobManager.currentJob.difficulty * algos[options.coin.algorithm].multiplier,
                'Network Difficulty:\t' + options.initStats.difficulty,
                'Network Hash Rate:\t' + util.getReadableHashRateString(options.initStats.networkHashRate),
                'Stratum Port(s):\t' + _this.options.initStats.stratumPorts.join(', '),
                'Pool Fee Percent:\t' + _this.options.feePercent + '%'
        ];

        if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0)
            infoLines.push('Block polling every:\t' + options.blockRefreshInterval + ' ms');

         emitSpecialLog(infoLines.join('\n\t\t\t\t\t\t'));
    }


    function OnBlockchainSynced(syncedCallback){

        var checkSynced = function(displayNotSynced){
            gbtParams = [];
            if (options.coin.reward == "POW"){
                gbtParams = [{"capabilities": [ "coinbasetxn", "workid", "coinbase/append" ], "rules": [ "segwit" ]}];
            }

            _this.daemon.cmd('getblocktemplate',
                gbtParams,
                function(results){
                    var synced = results.every(function(r){
                        return !r.error || r.error.code !== -10;
                    });
                    if (synced){
                        syncedCallback();
                    }
                    else{
                        if (displayNotSynced) displayNotSynced();
                        setTimeout(checkSynced, 5000);

                        //Only let the first fork show synced status or the log wil look flooded with it
                        if (!process.env.forkId || process.env.forkId === '0')
                            generateProgress();
                    }
                }
            );
        };
        checkSynced(function(){
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0')
                emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });


        var generateProgress = function(){

            _this.daemon.cmd('getinfo', [], function(results) {
                var blockCount = results.sort(function (a, b) {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;

                //get list of peers and their highest block height to compare to ours
                _this.daemon.cmd('getpeerinfo', [], function(results){

                    var peers = results[0].response;
                    var totalBlocks = peers.sort(function(a, b){
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;

                    var percent = (blockCount / totalBlocks * 100).toFixed(2);
                    emitWarningLog('Downloaded ' + percent + '% of blockchain from ' + peers.length + ' peers');
                });

            });
        };

    }


    function SetupApi() {
        if (typeof(options.api) !== 'object' || typeof(options.api.start) !== 'function') {
            return;
        } else {
            options.api.start(_this);
        }
    }


    function SetupPeer(){
        if (!options.p2p || !options.p2p.enabled)
            return;

        if (options.testnet && !options.coin.peerMagicTestnet){
            emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        }
        else if (!options.coin.peerMagic){
            emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }

        _this.peer = new peer(options);
        _this.peer.on('connected', function() {
            emitLog('p2p connection successful');
        }).on('connectionRejected', function(){
            emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', function(){
            emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', function(e){
            emitErrorLog('p2p connection failed - likely incorrect host or port');
        }).on('socketError', function(e){
            emitErrorLog('p2p had a socket error ' + JSON.stringify(e));
        }).on('error', function(msg){
            emitWarningLog('p2p had an error ' + msg);
        }).on('blockFound', function(hash){
            _this.processBlockNotify(hash, 'p2p');
        });
    }


    function SetupVarDiff(){
        _this.varDiff = {};
        Object.keys(options.ports).forEach(function(port) {
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }


    /*
    Coin daemons either use submitblock or getblocktemplate for submitting new blocks
     */
    function SubmitBlock(blockHex, finishedCallback){

        var rpcCommand, rpcArgs;
        if (options.hasSubmitMethod){
            rpcCommand = 'submitblock';
            rpcArgs = [blockHex];
        }
        else{
            rpcCommand = 'getblocktemplate';
            rpcArgs = [{'mode': 'submit', 'data': blockHex}];
        }


        _this.daemon.cmd(rpcCommand,
            rpcArgs,
            function(results){
                for (var i = 0; i < results.length; i++){
                    var result = results[i];
                    if (result.error) {
                        emitErrorLog('rpc error with daemon instance ' +
                                result.instance.index + ' when submitting block with ' + rpcCommand + ' ' +
                                JSON.stringify(result.error)
                        );
                        return;
                    }
                    else if (result.response === 'rejected') {
                        emitErrorLog('Daemon instance ' + result.instance.index + ' rejected a supposedly valid block');
                        return;
                    }
                }
                emitLog('Submitted Block using ' + rpcCommand + ' successfully to daemon instance(s)');
                finishedCallback();
            }
        );

    }


    function SubmitAuxBlock(aux, headerBuffer, coinbaseBuffer, blockHash, callback) {
        var branchProof = _this.jobManager.auxMerkleTree.getHashProof(util.uint256BufferFromHash(_this.auxes[aux].rpcData.hash));
        if(!branchProof) branchProof = Buffer.concat([util.varIntBuffer(0), util.packInt32LE(0)]);

        var coinbaseProof =
        Buffer.concat([
            util.varIntBuffer(_this.jobManager.currentJob.merkleTree.steps.length),
            Buffer.concat(_this.jobManager.currentJob.merkleTree.steps),
            util.packInt32LE(0)]
        );

        var auxpow = Buffer.concat([
            coinbaseBuffer,
            blockHash,
            coinbaseProof,
            branchProof,
            headerBuffer]
        );

        _this.auxes[aux].daemon.cmd('getauxblock',
            [_this.auxes[aux].rpcData.hash, auxpow.toString('hex')],
            function(results) {
                //console.log(results);
                //console.log(_this.auxes[aux]);
                for (var i = 0; i < results.length; i++){
                    var result = results[i];
                    if(result.error && result.error !== null) {
                        emitErrorLog('Failed to submit potential auxiliary block: ' + JSON.stringify(result.error));
                        return;
                    } else {
                        if(!result.response) {
                            emitWarningLog('Submitted auxiliary block was rejected by the ' + _this.auxes[aux].name + ' network! Check its log for more information');
                            return;
                        }
                    }
                }
                emitInfoLog('Submitted auxiliary block successfully to the '+_this.auxes[aux].name+' daemon instance(s) with BlockHash: '+ _this.auxes[aux].rpcData.hash);
                callback(_this.auxes[aux].rpcData.hash, aux);
            });
    }


    function SetupRecipients(){
        var recipients = [];
        options.feePercent = 0;
        options.rewardRecipients = options.rewardRecipients || {};
        for (var r in options.rewardRecipients){
            var percent = options.rewardRecipients[r];
            var rObj = {
                percent: percent / 100
            };
            try {
                if (r.length === 40)
                    rObj.script = util.miningKeyToScript(r);
                else
                    rObj.script = util.addressToScript(r);
                recipients.push(rObj);
                options.feePercent += percent;
            }
            catch(e){
                emitErrorLog('Error generating transaction output script for ' + r + ' in rewardRecipients');
            }
        }
        if (recipients.length === 0){
            emitErrorLog('No rewardRecipients have been setup which means no fees will be taken');
        }
        options.recipients = recipients;
    }

    function SetupJobManager(){

        _this.jobManager = new jobManager(options);

        _this.jobManager.on('newBlock', function(blockTemplate){
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', function(blockTemplate){
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                var job = blockTemplate.getJobParams();
                job[8] = false;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function(shareData, blockHexInvalid, blockHex){

            var auxResult = function(hash, aux) {
                if(!hash) return;
                CheckBlockAccepted(hash, _this.auxes[aux].daemon, function(accepted, tx, height, value) {
                    if(!accepted) emitErrorLog('Block was not detected to have been accepted by ' + _this.auxes[aux].name + ' network: ' + hash);
                    // Push a message to alert that an auxillary block was found
                    // First get transaction ID of our coinbase transaction
                    _this.auxes[aux].daemon.cmd('gettransaction', [tx], function(res) {
                        var cmdResponse = res[0].response;
                        var cmdError = res[0].error;
                        if(cmdError) {
                          emitErrorLog('Some error occured: ' + JSON.stringify(cmdError));
                        }
                        else {
                        _this.emit('auxblock', options.auxes[aux].symbol, height, hash, tx, cmdResponse.details[0].amount, shareData.difficulty, shareData.worker);
                        }
                    });
                    UpdateAuxes();
                    // Cant do anything here yet
                    // Skip the get block template. Just a secondary test
                });
            };


            if(!shareData.error) {
                for(var i = 0;i < _this.auxes.length;i++) {
                    //var aux = ;
                    if(_this.auxes[i].rpcData.target.ge(shareData.blockBigNum)) {
                        SubmitAuxBlock(i, new Buffer(blockHexInvalid, 'hex').slice(0,80), shareData.coinbaseBuffer, shareData.headerHash, auxResult);
                    }
                }
            }



            // Now for parent chain checking
            var isValidShare = !shareData.error;
            var isValidBlock = !!blockHex;
            var emitShare = function(){
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };

            /*
            If we calculated that the block solution was found,
            before we emit the share, lets submit the block,
            then check if it was accepted using RPC getblock
            */
            if (!isValidBlock)
                emitShare();
            else{
                SubmitBlock(blockHex, function(){
                    CheckBlockAccepted(shareData.blockHash, _this.daemon, function(isAccepted, tx, height, value){
                        isValidBlock = isAccepted;
                        shareData.txHash = tx;
                        emitShare();
                        // Also emit the new block callback
                        _this.emit('block', options.coin.symbol, height, shareData.blockHash, tx, shareData.blockReward * 0.00000001, shareData.difficulty, shareData.worker);
                        GetBlockTemplate(function(error, result, foundNewBlock) {
                            if (foundNewBlock)
                                emitLog('Block notification via RPC after block submission');
                        });

                    });
                });
            }
        }).on('log', function(severity, message){
            _this.emit('log', severity, message);
        });
    }


    function SetupDaemonInterfaces(finishedCallback){
        if (!Array.isArray(options.daemons) || options.daemons.length < 1){
            emitErrorLog('No daemons have been configured - pool cannot start');
            return;
        }

        var setupDaemon = function(daemons, callback) {

            if(!callback) callback = function() {};

            var d = new daemon.interface(daemons, function(severity, message){
                _this.emit('log', severity , message);
            });

            d.once('online', function(){
                callback();

            }).on('connectionFailed', function(error){
                emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));

            }).on('error', function(message){
                emitErrorLog(message);

            });

            d.init();
            return d;
        };

        // Setup auxillary daemons
        _this.auxes = [];
        if (options.auxes) {
          for(var i = 0;i < options.auxes.length;i++) {
              if(!Array.isArray(options.auxes[i].daemons) || options.auxes[i].daemons.length < 1) {
                  emitErrorLog('No daemons have been configured for the auxillary coin: ' + options.auxes[i].name + '. Please specify before the pool starts.');
                  _this.daemon = undefined; // Should force program to close naturally
                  return;
              }
              var a = {};
              a.name = options.auxes[i].name; // I want at least this...
              a.daemon = setupDaemon(options.auxes[i].daemons);
              _this.auxes.push(a);
          }
        }

        // Setup parent daemon
        _this.daemon = setupDaemon(options.daemons, finishedCallback);
    }


    function DetectCoinData(finishedCallback){
        var batchRpcCalls = [
            ['validateaddress', [options.address]],
            ['getdifficulty', []],
            ['getblockchaininfo', []],
            ['getnetworkinfo', []],
            ['getmininginfo', []],
            ['submitblock', []]
        ];
        _this.daemon.batchCmd(batchRpcCalls, function(error, results){
            if (error || !results){
                emitErrorLog('Could not start pool, error with init batch RPC call: ' + JSON.stringify(error));
                return;
            }

            var rpcResults = {};

            for (var i = 0; i < results.length; i++){
                var rpcCall = batchRpcCalls[i][0];
                var r = results[i];
                rpcResults[rpcCall] = r.result || r.error;
                if (rpcCall !== 'submitblock' && (r.error || !r.result)){
                    emitErrorLog('Could not start pool, error with init RPC ' + rpcCall + ' - ' + JSON.stringify(r.error));
                    return;
                }
            }

            if (!rpcResults.validateaddress.isvalid){
                emitErrorLog('Daemon reports address is not valid');
                return;
            }

            if (!options.coin.reward) {
                if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty)
                    options.coin.reward = 'POS';
                else
                    options.coin.reward = 'POW';
            }

            /* POS coins must use the pubkey in coinbase transaction, and pubkey is
               only given if address is owned by wallet.*/
            if (options.coin.reward === 'POS' && typeof(rpcResults.validateaddress.pubkey) == 'undefined') {
                emitErrorLog('The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }

            options.poolAddressScript = (function(){
                switch(options.coin.reward){
                    case 'POS':
                        return util.pubkeyToScript(rpcResults.validateaddress.pubkey);
                    case 'POW':
                        return util.addressToScript(rpcResults.validateaddress.address);
                }
            })();

            // Use getblockchaininfo and getnetworkinfo instead of getinfo
            options.testnet = rpcResults.getblockchaininfo.chain === 'test';
            options.protocolVersion = rpcResults.getnetworkinfo.protocolversion;

            options.initStats = {
                connections: rpcResults.getnetworkinfo.connections,
                difficulty: rpcResults.getdifficulty * algos[options.coin.algorithm].multiplier,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };

            if (rpcResults.submitblock.message === 'Method not found'){
                options.hasSubmitMethod = false;
            }
            else if (rpcResults.submitblock.code === -1){
                options.hasSubmitMethod = true;
            }
            else {
                emitErrorLog('Could not detect block submission RPC method, ' + JSON.stringify(results));
                return;
            }

            finishedCallback();
        });
    }



    function StartStratumServer(finishedCallback){
        _this.stratumServer = new stratum.Server(options, authorizeFn);

        _this.stratumServer.on('started', function(){
            options.initStats.stratumPorts = Object.keys(options.ports);
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();

        }).on('broadcastTimeout', function(){
            emitLog('No new blocks for ' + options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');

            GetBlockTemplate(function(error, rpcData, processedBlock){
                if (error || processedBlock) return;
                _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', function(client){
            if (typeof(_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', function(diff){
                _this.emit('difficultyUpdate', client.workerName, diff);

            }).on('subscription', function(params, resultCallback){

                var extraNonce = _this.jobManager.extraNonceCounter.next();
                var extraNonce2Size = _this.jobManager.extraNonce2Size;
                resultCallback(null,
                    extraNonce,
                    extraNonce2Size
                );

                if (typeof(options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                    this.sendDifficulty(options.ports[client.socket.localPort].diff);
                } else {
                    this.sendDifficulty(8);
                }

                this.sendMiningJob(_this.jobManager.currentJob.getJobParams());

            }).on('submit', function(params, resultCallback){
                var result =_this.jobManager.processShare(
                    params.jobId,
                    client.previousDifficulty,
                    client.difficulty,
                    client.extraNonce1,
                    params.extraNonce2,
                    params.nTime,
                    params.nonce,
                    client.remoteAddress,
                    client.socket.localPort,
                    params.name
                );

                resultCallback(result.error, result.result ? true : null);

            }).on('malformedMessage', function (message) {
                emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + message);

            }).on('socketError', function(err) {
                emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));

            }).on('socketTimeout', function(reason){
                emitWarningLog('Connected timed out for ' + client.getLabel() + ': ' + reason)

            }).on('socketDisconnect', function() {
                //emitLog('Socket disconnected from ' + client.getLabel());

            }).on('kickedBannedIP', function(remainingBanTime){
                emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');

            }).on('forgaveBannedIP', function(){
                emitLog('Forgave banned IP ' + client.remoteAddress);

            }).on('unknownStratumMethod', function(fullMessage) {
                emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);

            }).on('socketFlooded', function() {
                emitWarningLog('Detected socket flooding from ' + client.getLabel());

            }).on('tcpProxyError', function(data) {
                emitErrorLog('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);

            }).on('bootedBannedWorker', function(){
                emitWarningLog('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');

            }).on('triggerBan', function(reason){
                emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }



    function SetupBlockPolling(){
        if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0){
            emitLog('Block template polling has been disabled');
            return;
        }

        var pollingInterval = options.blockRefreshInterval;

        blockPollingIntervalId = setInterval(function () {
            GetBlockTemplate(function(error, result, foundNewBlock){
                if (foundNewBlock)
                    emitLog('getting block notification via RPC polling');
            });
        }, pollingInterval);
    }



    function GetBlockTemplate(callback, force){
        gbtParams = [];
        if (_this.options.coin.getblocktemplate == "POS") {
            gbtParams = [{"mode": "template" }];
        } else {
            gbtParams = [{"capabilities": [ "coinbasetxn", "workid", "coinbase/append" ], "rules": [ "segwit" ]}];
        }
        _this.daemon.cmd('getblocktemplate',
            gbtParams,
            function(result){
                if (result.error){
                    emitErrorLog('getblocktemplate call failed for daemon instance ' +
                        result.instance.index + ' with error ' + JSON.stringify(result.error));
                    callback(result.error);
                } else {
                    // Add auxes to the RPC data to process
                    var data = result.response;
                    data.auxes = [];
                    for(var i = 0;i < _this.auxes.length;i++) data.auxes.push(_this.auxes[i].rpcData);
                    var processedNewBlock = _this.jobManager.isNewWork(data);
                    if(processedNewBlock || force) _this.jobManager.processTemplate(data);
                    callback(null, result.response, processedNewBlock);
                    callback = function(){};
                }
            }, true
        );
    }

    function GetAuxWork(index, callback){
        _this.auxes[index].daemon.cmd('getauxblock', [],
            function(result){
                if (result.error){
                    emitErrorLog('getauxblock call failed for daemon instance ' +
                        result.instance.index + ' with error ' + JSON.stringify(result.error));
                    callback(result.error);
                } else {
                    // Process response
                    if(_this.auxes[index].rpcData) {
                        if(_this.auxes[index].rpcData.hash != result.response.hash) _this.updateNeeded = true;
                    }
                    _this.auxes[index].rpcData = result.response;
                    _this.auxes[index].rpcData.target = bignum.fromBuffer(util.uint256BufferFromHash(_this.auxes[index].rpcData.target, {endian: 'little', size: 32}));
                    callback(null, result.response, false);
                    //callback = function(){};
                }
            }, true);
    }

    function CheckBlockAccepted(blockHash, daemon, callback){
        //setTimeout(function(){
            daemon.cmd('getblock',
                [blockHash],
                function(results){
                    var validResults = results.filter(function(result){
                        return result.response && (result.response.hash === blockHash);
                    });

                    if (validResults.length >= 1){
                        callback(true, validResults[0].response.tx[0], validResults[0].response.height);
                    }
                    else{
                        callback(false);
                    }
                }
            );
        //}, 500);
    }



    /**
     * This method is being called from the blockNotify so that when a new block is discovered by the daemon
     * We can inform our miners about the newly found block
    **/
    this.processBlockNotify = function(blockHash, sourceTrigger) {
        emitLog('Block notification via ' + sourceTrigger);
        if (typeof(_this.jobManager) !== 'undefined'){
            if (typeof(_this.jobManager.currentJob) !== 'undefined' && blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash){
                GetBlockTemplate(function(error, result){
                    if (error)
                        emitErrorLog('Block notify error getting block template for ' + options.coin.name);
                });
            }
        }
    };


    this.relinquishMiners = function(filterFn, resultCback) {
        var origStratumClients = this.stratumServer.getStratumClients();

        var stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({subId: subId, client: origStratumClients[subId]});
        });
        async.filter(
            stratumClients,
            filterFn,
            function (clientsToRelinquish) {
                clientsToRelinquish.forEach(function(cObj) {
                    cObj.client.removeAllListeners();
                    _this.stratumServer.removeStratumClientBySubId(cObj.subId);
                });

                process.nextTick(function () {
                    resultCback(
                        clientsToRelinquish.map(
                            function (item) {
                                return item.client;
                            }
                        )
                    );
                });
            }
        );
    };


    this.attachMiners = function(miners) {
        miners.forEach(function (clientObj) {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

    };


    this.getStratumServer = function() {
        return _this.stratumServer;
    };


    this.setVarDiff = function(port, varDiffConfig) {
        if (typeof(_this.varDiff[port]) != 'undefined' ) {
            _this.varDiff[port].removeAllListeners();
        }
        var varDiffInstance = new varDiff(port, varDiffConfig);
        _this.varDiff[port] = varDiffInstance;
        _this.varDiff[port].on('newDifficulty', function(client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);

            /*if (options.varDiff.mode === 'fast'){
                 //Send new difficulty, then force miner to use new diff by resending the
                 //current job parameters but with the "clean jobs" flag set to false
                 //so the miner doesn't restart work and submit duplicate shares
                client.sendDifficulty(newDiff);
                var job = _this.jobManager.currentJob.getJobParams();
                job[8] = false;
                client.sendMiningJob(job);
            }*/

        });
    };

};
pool.prototype.__proto__ = events.EventEmitter.prototype;
