/**
* @description Meshcentral web relay server
* @author Ylian Saint-Hilaire
* @copyright Intel Corporation 2018-2022
* @license Apache-2.0
* @version v0.0.1
*/

/*jslint node: true */
/*jshint node: true */
/*jshint strict:false */
/*jshint -W097 */
/*jshint esversion: 6 */
"use strict";

// Construct a HTTP redirection web server object
module.exports.CreateWebRelayServer = function (parent, db, args, certificates, func) {
    var obj = {};
    obj.parent = parent;
    obj.db = db;
    obj.express = require('express');
    obj.expressWs = null;
    obj.tlsServer = null;
    obj.net = require('net');
    obj.app = obj.express();
    obj.webRelayServer = null;
    obj.port = 0;
    obj.relayTunnels = {}             // RelayID --> Web Tunnel
    const constants = (require('crypto').constants ? require('crypto').constants : require('constants')); // require('constants') is deprecated in Node 11.10, use require('crypto').constants instead.
    var tlsSessionStore = {};         // Store TLS session information for quick resume.
    var tlsSessionStoreCount = 0;     // Number of cached TLS session information in store.

    if (args.trustedproxy) {
        // Reverse proxy should add the "X-Forwarded-*" headers
        try {
            obj.app.set('trust proxy', args.trustedproxy);
        } catch (ex) {
            // If there is an error, try to resolve the string
            if ((args.trustedproxy.length == 1) && (typeof args.trustedproxy[0] == 'string')) {
                require('dns').lookup(args.trustedproxy[0], function (err, address, family) { if (err == null) { obj.app.set('trust proxy', address); args.trustedproxy = [address]; } });
            }
        }
    }
    else if (typeof args.tlsoffload == 'object') {
        // Reverse proxy should add the "X-Forwarded-*" headers
        try {
            obj.app.set('trust proxy', args.tlsoffload);
        } catch (ex) {
            // If there is an error, try to resolve the string
            if ((Array.isArray(args.tlsoffload)) && (args.tlsoffload.length == 1) && (typeof args.tlsoffload[0] == 'string')) {
                require('dns').lookup(args.tlsoffload[0], function (err, address, family) { if (err == null) { obj.app.set('trust proxy', address); args.tlsoffload = [address]; } });
            }
        }
    }

    // Add HTTP security headers to all responses
    obj.app.use(function (req, res, next) {
        parent.debug('webrequest', req.url + ' (RelayServer)');
        res.removeHeader('X-Powered-By');
        res.set({
            'strict-transport-security': 'max-age=60000; includeSubDomains',
            'Referrer-Policy': 'no-referrer',
            'x-frame-options': 'SAMEORIGIN',
            'X-XSS-Protection': '1; mode=block',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline';"
        });

        // Set the real IP address of the request
        // If a trusted reverse-proxy is sending us the remote IP address, use it.
        var ipex = '0.0.0.0', xforwardedhost = req.headers.host;
        if (typeof req.connection.remoteAddress == 'string') { ipex = (req.connection.remoteAddress.startsWith('::ffff:')) ? req.connection.remoteAddress.substring(7) : req.connection.remoteAddress; }
        if (
            (args.trustedproxy === true) || (args.tlsoffload === true) ||
            ((typeof args.trustedproxy == 'object') && (isIPMatch(ipex, args.trustedproxy))) ||
            ((typeof args.tlsoffload == 'object') && (isIPMatch(ipex, args.tlsoffload)))
        ) {
            // Get client IP
            if (req.headers['cf-connecting-ip']) { // Use CloudFlare IP address if present
                req.clientIp = req.headers['cf-connecting-ip'].split(',')[0].trim();
            } else if (req.headers['x-forwarded-for']) {
                req.clientIp = req.headers['x-forwarded-for'].split(',')[0].trim();
            } else if (req.headers['x-real-ip']) {
                req.clientIp = req.headers['x-real-ip'].split(',')[0].trim();
            } else {
                req.clientIp = ipex;
            }

            // If there is a port number, remove it. This will only work for IPv4, but nice for people that have a bad reverse proxy config.
            const clientIpSplit = req.clientIp.split(':');
            if (clientIpSplit.length == 2) { req.clientIp = clientIpSplit[0]; }

            // Get server host
            if (req.headers['x-forwarded-host']) { xforwardedhost = req.headers['x-forwarded-host'].split(',')[0]; } // If multiple hosts are specified with a comma, take the first one.
        } else {
            req.clientIp = ipex;
        }

        return next();
    });

    // This is the magic URL that will setup the relay session
    obj.app.get('/control-redirect.ashx', function (req, res) {
        res.set({ 'Cache-Control': 'no-store' });
        parent.debug('web', 'webRelaySetup');

        console.log('req.query', req.query);

        res.redirect('/');
    });

    // Start the server, only after users and meshes are loaded from the database.
    if (args.tlsoffload) {
        // Setup the HTTP server without TLS
        obj.expressWs = require('express-ws')(obj.app, null, { wsOptions: { perMessageDeflate: (args.wscompression === true) } });
    } else {
        // Setup the HTTP server with TLS, use only TLS 1.2 and higher with perfect forward secrecy (PFS).
        const tlsOptions = { cert: certificates.web.cert, key: certificates.web.key, ca: certificates.web.ca, rejectUnauthorized: true, ciphers: "HIGH:TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:TLS_AES_128_CCM_8_SHA256:TLS_AES_128_CCM_SHA256:TLS_CHACHA20_POLY1305_SHA256", secureOptions: constants.SSL_OP_NO_SSLv2 | constants.SSL_OP_NO_SSLv3 | constants.SSL_OP_NO_COMPRESSION | constants.SSL_OP_CIPHER_SERVER_PREFERENCE | constants.SSL_OP_NO_TLSv1 | constants.SSL_OP_NO_TLSv1_1 };
        obj.tlsServer = require('https').createServer(tlsOptions, obj.app);
        obj.tlsServer.on('secureConnection', function () { /*console.log('tlsServer secureConnection');*/ });
        obj.tlsServer.on('error', function (err) { console.log('tlsServer error', err); });
        obj.tlsServer.on('newSession', function (id, data, cb) { if (tlsSessionStoreCount > 1000) { tlsSessionStoreCount = 0; tlsSessionStore = {}; } tlsSessionStore[id.toString('hex')] = data; tlsSessionStoreCount++; cb(); });
        obj.tlsServer.on('resumeSession', function (id, cb) { cb(null, tlsSessionStore[id.toString('hex')] || null); });
        obj.expressWs = require('express-ws')(obj.app, obj.tlsServer, { wsOptions: { perMessageDeflate: (args.wscompression === true) } });
    }

    // Find a free port starting with the specified one and going up.
    function CheckListenPort(port, addr, func) {
        var s = obj.net.createServer(function (socket) { });
        obj.webRelayServer = s.listen(port, addr, function () { s.close(function () { if (func) { func(port, addr); } }); }).on("error", function (err) {
            if (args.exactports) { console.error("ERROR: MeshCentral HTTP relay server port " + port + " not available."); process.exit(); }
            else { if (port < 65535) { CheckListenPort(port + 1, addr, func); } else { if (func) { func(0); } } }
        });
    }

    // Start the ExpressJS web server, if the port is busy try the next one.
    function StartWebRelayServer(port, addr) {
        if (port == 0 || port == 65535) { return; }
        if (obj.tlsServer != null) {
            if (args.lanonly == true) {
                obj.tcpServer = obj.tlsServer.listen(port, addr, function () { console.log('MeshCentral HTTPS relay server running on port ' + port + ((args.aliasport != null) ? (', alias port ' + args.aliasport) : '') + '.'); });
            } else {
                obj.tcpServer = obj.tlsServer.listen(port, addr, function () { console.log('MeshCentral HTTPS relay server running on ' + certificates.CommonName + ':' + port + ((args.aliasport != null) ? (', alias port ' + args.aliasport) : '') + '.'); });
                obj.parent.updateServerState('servername', certificates.CommonName);
            }
            if (obj.parent.authlog) { obj.parent.authLog('https', 'Web relay server listening on ' + ((addr != null) ? addr : '0.0.0.0') + ' port ' + port + '.'); }
            obj.parent.updateServerState('https-relay-port', port);
            if (args.aliasport != null) { obj.parent.updateServerState('https-relay-aliasport', args.aliasport); }
        } else {
            obj.tcpServer = obj.app.listen(port, addr, function () { console.log('MeshCentral HTTP relay server running on port ' + port + ((args.aliasport != null) ? (', alias port ' + args.aliasport) : '') + '.'); });
            obj.parent.updateServerState('http-relay-port', port);
            if (args.aliasport != null) { obj.parent.updateServerState('http-relay-aliasport', args.aliasport); }
        }
        obj.port = port;
    }

    CheckListenPort(args.relayport, args.relayportbind, StartWebRelayServer);

    return obj;
};
