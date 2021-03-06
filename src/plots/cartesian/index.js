/**
* Copyright 2012-2018, Plotly, Inc.
* All rights reserved.
*
* This source code is licensed under the MIT license found in the
* LICENSE file in the root directory of this source tree.
*/


'use strict';

var d3 = require('d3');
var Lib = require('../../lib');
var Plots = require('../plots');
var getModuleCalcData = require('../get_data').getModuleCalcData;

var axisIds = require('./axis_ids');
var constants = require('./constants');
var xmlnsNamespaces = require('../../constants/xmlns_namespaces');

exports.name = 'cartesian';

exports.attr = ['xaxis', 'yaxis'];

exports.idRoot = ['x', 'y'];

exports.idRegex = constants.idRegex;

exports.attrRegex = constants.attrRegex;

exports.attributes = require('./attributes');

exports.layoutAttributes = require('./layout_attributes');

exports.supplyLayoutDefaults = require('./layout_defaults');

exports.transitionAxes = require('./transition_axes');

exports.finalizeSubplots = function(layoutIn, layoutOut) {
    var subplots = layoutOut._subplots;
    var xList = subplots.xaxis;
    var yList = subplots.yaxis;
    var spSVG = subplots.cartesian;
    var spAll = spSVG.concat(subplots.gl2d || []);
    var allX = {};
    var allY = {};
    var i, xi, yi;

    for(i = 0; i < spAll.length; i++) {
        var parts = spAll[i].split('y');
        allX[parts[0]] = 1;
        allY['y' + parts[1]] = 1;
    }

    // check for x axes with no subplot, and make one from the anchor of that x axis
    for(i = 0; i < xList.length; i++) {
        xi = xList[i];
        if(!allX[xi]) {
            yi = (layoutIn[axisIds.id2name(xi)] || {}).anchor;
            if(!constants.idRegex.y.test(yi)) yi = 'y';
            spSVG.push(xi + yi);
            spAll.push(xi + yi);

            if(!allY[yi]) {
                allY[yi] = 1;
                Lib.pushUnique(yList, yi);
            }
        }
    }

    // same for y axes with no subplot
    for(i = 0; i < yList.length; i++) {
        yi = yList[i];
        if(!allY[yi]) {
            xi = (layoutIn[axisIds.id2name(yi)] || {}).anchor;
            if(!constants.idRegex.x.test(xi)) xi = 'x';
            spSVG.push(xi + yi);
            spAll.push(xi + yi);

            if(!allX[xi]) {
                allX[xi] = 1;
                Lib.pushUnique(xList, xi);
            }
        }
    }

    // finally, if we've gotten here we're supposed to show cartesian...
    // so if there are NO subplots at all, make one from the first
    // x & y axes in the input layout
    if(!spAll.length) {
        var keys = Object.keys(layoutIn);
        xi = '';
        yi = '';
        for(i = 0; i < keys.length; i++) {
            var ki = keys[i];
            if(constants.attrRegex.test(ki)) {
                var axLetter = ki.charAt(0);
                if(axLetter === 'x') {
                    if(!xi || (+ki.substr(5) < +xi.substr(5))) {
                        xi = ki;
                    }
                }
                else if(!yi || (+ki.substr(5) < +yi.substr(5))) {
                    yi = ki;
                }
            }
        }
        xi = xi ? axisIds.name2id(xi) : 'x';
        yi = yi ? axisIds.name2id(yi) : 'y';
        xList.push(xi);
        yList.push(yi);
        spSVG.push(xi + yi);
    }
};

exports.plot = function(gd, traces, transitionOpts, makeOnCompleteCallback) {
    var fullLayout = gd._fullLayout;
    var subplots = fullLayout._subplots.cartesian;
    var calcdata = gd.calcdata;
    var i;

    // If traces is not provided, then it's a complete replot and missing
    // traces are removed
    if(!Array.isArray(traces)) {
        traces = [];

        for(i = 0; i < calcdata.length; i++) {
            traces.push(i);
        }
    }

    // clear gl frame, if any, since we preserve drawing buffer
    if(fullLayout._glcanvas && fullLayout._glcanvas.size()) {
        fullLayout._glcanvas.each(function(d) {
            if(d.regl) {
                d.regl.clear({
                    color: true
                });
            }
        });
    }

    for(i = 0; i < subplots.length; i++) {
        var subplot = subplots[i],
            subplotInfo = fullLayout._plots[subplot];

        // Get all calcdata for this subplot:
        var cdSubplot = [];
        var pcd;

        for(var j = 0; j < calcdata.length; j++) {
            var cd = calcdata[j],
                trace = cd[0].trace;

            // Skip trace if whitelist provided and it's not whitelisted:
            // if (Array.isArray(traces) && traces.indexOf(i) === -1) continue;
            if(trace.xaxis + trace.yaxis === subplot) {
                // XXX: Should trace carpet dependencies. Only replot all carpet plots if the carpet
                // axis has actually changed:
                //
                // If this trace is specifically requested, add it to the list:
                if(traces.indexOf(trace.index) !== -1 || trace.carpet) {
                    // Okay, so example: traces 0, 1, and 2 have fill = tonext. You animate
                    // traces 0 and 2. Trace 1 also needs to be updated, otherwise its fill
                    // is outdated. So this retroactively adds the previous trace if the
                    // traces are interdependent.
                    if(
                        pcd &&
                        pcd[0].trace.xaxis + pcd[0].trace.yaxis === subplot &&
                        ['tonextx', 'tonexty', 'tonext'].indexOf(trace.fill) !== -1 &&
                        cdSubplot.indexOf(pcd) === -1
                    ) {
                        cdSubplot.push(pcd);
                    }

                    cdSubplot.push(cd);
                }

                // Track the previous trace on this subplot for the retroactive-add step
                // above:
                pcd = cd;
            }
        }

        plotOne(gd, subplotInfo, cdSubplot, transitionOpts, makeOnCompleteCallback);
    }
};

function plotOne(gd, plotinfo, cdSubplot, transitionOpts, makeOnCompleteCallback) {
    var fullLayout = gd._fullLayout,
        modules = fullLayout._modules;

    // remove old traces, then redraw everything
    //
    // TODO: scatterlayer is manually excluded from this since it knows how
    // to update instead of fully removing and redrawing every time. The
    // remaining plot traces should also be able to do this. Once implemented,
    // we won't need this - which should sometimes be a big speedup.
    if(plotinfo.plot) {
        plotinfo.plot.selectAll('g:not(.scatterlayer)').selectAll('g.trace').remove();
    }

    // plot all traces for each module at once
    for(var j = 0; j < modules.length; j++) {
        var _module = modules[j];

        // skip over non-cartesian trace modules
        if(_module.basePlotModule.name !== 'cartesian') continue;

        // plot all traces of this type on this subplot at once
        var cdModule = getModuleCalcData(cdSubplot, _module);

        if(_module.plot) _module.plot(gd, plotinfo, cdModule, transitionOpts, makeOnCompleteCallback);
    }
}

exports.clean = function(newFullData, newFullLayout, oldFullData, oldFullLayout) {
    var oldModules = oldFullLayout._modules || [],
        newModules = newFullLayout._modules || [];

    var hadScatter, hasScatter, hadGl, hasGl, i, oldPlots, ids, subplotInfo;


    for(i = 0; i < oldModules.length; i++) {
        if(oldModules[i].name === 'scatter') {
            hadScatter = true;
        }
        break;
    }

    for(i = 0; i < newModules.length; i++) {
        if(newModules[i].name === 'scatter') {
            hasScatter = true;
            break;
        }
    }

    for(i = 0; i < oldModules.length; i++) {
        if(oldModules[i].name === 'scattergl') {
            hadGl = true;
        }
        break;
    }

    for(i = 0; i < newModules.length; i++) {
        if(newModules[i].name === 'scattergl') {
            hasGl = true;
            break;
        }
    }

    if(hadScatter && !hasScatter) {
        oldPlots = oldFullLayout._plots;
        ids = Object.keys(oldPlots || {});

        for(i = 0; i < ids.length; i++) {
            subplotInfo = oldPlots[ids[i]];

            if(subplotInfo.plot) {
                subplotInfo.plot.select('g.scatterlayer')
                    .selectAll('g.trace')
                    .remove();
            }
        }

        oldFullLayout._infolayer.selectAll('g.rangeslider-container')
            .select('g.scatterlayer')
            .selectAll('g.trace')
            .remove();
    }

    if(hadGl && !hasGl) {
        oldPlots = oldFullLayout._plots;
        ids = Object.keys(oldPlots || {});

        for(i = 0; i < ids.length; i++) {
            subplotInfo = oldPlots[ids[i]];

            if(subplotInfo._scene) {
                subplotInfo._scene.destroy();
            }
        }
    }

    var oldSubplotList = oldFullLayout._subplots || {};
    var newSubplotList = newFullLayout._subplots || {xaxis: [], yaxis: []};

    // delete any titles we don't need anymore
    // check if axis list has changed, and if so clear old titles
    if(oldSubplotList.xaxis && oldSubplotList.yaxis) {
        var oldAxIDs = oldSubplotList.xaxis.concat(oldSubplotList.yaxis);
        var newAxIDs = newSubplotList.xaxis.concat(newSubplotList.yaxis);

        for(i = 0; i < oldAxIDs.length; i++) {
            if(newAxIDs.indexOf(oldAxIDs[i]) === -1) {
                oldFullLayout._infolayer.selectAll('.g-' + oldAxIDs[i] + 'title').remove();
            }
        }
    }

    // if we've gotten rid of all cartesian traces, remove all the subplot svg items
    var hadCartesian = (oldFullLayout._has && oldFullLayout._has('cartesian'));
    var hasCartesian = (newFullLayout._has && newFullLayout._has('cartesian'));

    if(hadCartesian && !hasCartesian) {
        purgeSubplotLayers(oldFullLayout._cartesianlayer.selectAll('.subplot'), oldFullLayout);
        oldFullLayout._defs.selectAll('.axesclip').remove();
    }
};

exports.drawFramework = function(gd) {
    var fullLayout = gd._fullLayout,
        subplotData = makeSubplotData(gd);

    var subplotLayers = fullLayout._cartesianlayer.selectAll('.subplot')
        .data(subplotData, Lib.identity);

    subplotLayers.enter().append('g')
        .attr('class', function(name) { return 'subplot ' + name; });

    subplotLayers.order();

    subplotLayers.exit()
        .call(purgeSubplotLayers, fullLayout);

    subplotLayers.each(function(name) {
        var plotinfo = fullLayout._plots[name];

        // keep ref to plot group
        plotinfo.plotgroup = d3.select(this);

        // initialize list of overlay subplots
        plotinfo.overlays = [];

        makeSubplotLayer(plotinfo);
        // fill in list of overlay subplots
        if(plotinfo.mainplot) {
            var mainplot = fullLayout._plots[plotinfo.mainplot];
            mainplot.overlays.push(plotinfo);
        }

        // make separate drag layers for each subplot,
        // but append them to paper rather than the plot groups,
        // so they end up on top of the rest
        plotinfo.draglayer = joinLayer(fullLayout._draggers, 'g', name);
    });
};

exports.rangePlot = function(gd, plotinfo, cdSubplot) {
    makeSubplotLayer(plotinfo);
    plotOne(gd, plotinfo, cdSubplot);
    Plots.style(gd);
};

function makeSubplotData(gd) {
    var fullLayout = gd._fullLayout,
        subplots = Object.keys(fullLayout._plots);

    var subplotData = [],
        overlays = [];

    for(var i = 0; i < subplots.length; i++) {
        var subplot = subplots[i],
            plotinfo = fullLayout._plots[subplot];

        var xa = plotinfo.xaxis;
        var ya = plotinfo.yaxis;
        var xa2 = xa._mainAxis;
        var ya2 = ya._mainAxis;

        var mainplot = xa2._id + ya2._id;
        if(mainplot !== subplot && subplots.indexOf(mainplot) !== -1) {
            plotinfo.mainplot = mainplot;
            plotinfo.mainplotinfo = fullLayout._plots[mainplot];
            overlays.push(subplot);
        }
        else {
            subplotData.push(subplot);
        }
    }

    // main subplots before overlays
    subplotData = subplotData.concat(overlays);

    return subplotData;
}

function makeSubplotLayer(plotinfo) {
    var plotgroup = plotinfo.plotgroup;
    var id = plotinfo.id;
    var xLayer = constants.layerValue2layerClass[plotinfo.xaxis.layer];
    var yLayer = constants.layerValue2layerClass[plotinfo.yaxis.layer];

    if(!plotinfo.mainplot) {
        var backLayer = joinLayer(plotgroup, 'g', 'layer-subplot');
        plotinfo.shapelayer = joinLayer(backLayer, 'g', 'shapelayer');
        plotinfo.imagelayer = joinLayer(backLayer, 'g', 'imagelayer');

        plotinfo.gridlayer = joinLayer(plotgroup, 'g', 'gridlayer');

        plotinfo.zerolinelayer = joinLayer(plotgroup, 'g', 'zerolinelayer');

        joinLayer(plotgroup, 'path', 'xlines-below');
        joinLayer(plotgroup, 'path', 'ylines-below');
        plotinfo.overlinesBelow = joinLayer(plotgroup, 'g', 'overlines-below');

        joinLayer(plotgroup, 'g', 'xaxislayer-below');
        joinLayer(plotgroup, 'g', 'yaxislayer-below');
        plotinfo.overaxesBelow = joinLayer(plotgroup, 'g', 'overaxes-below');

        plotinfo.plot = joinLayer(plotgroup, 'g', 'plot');
        plotinfo.overplot = joinLayer(plotgroup, 'g', 'overplot');

        joinLayer(plotgroup, 'path', 'xlines-above');
        joinLayer(plotgroup, 'path', 'ylines-above');
        plotinfo.overlinesAbove = joinLayer(plotgroup, 'g', 'overlines-above');

        joinLayer(plotgroup, 'g', 'xaxislayer-above');
        joinLayer(plotgroup, 'g', 'yaxislayer-above');
        plotinfo.overaxesAbove = joinLayer(plotgroup, 'g', 'overaxes-above');

        // set refs to correct layers as determined by 'axis.layer'
        plotinfo.xlines = plotgroup.select('.xlines-' + xLayer);
        plotinfo.ylines = plotgroup.select('.ylines-' + yLayer);
        plotinfo.xaxislayer = plotgroup.select('.xaxislayer-' + xLayer);
        plotinfo.yaxislayer = plotgroup.select('.yaxislayer-' + yLayer);
    }
    else {
        var mainplotinfo = plotinfo.mainplotinfo;
        var mainplotgroup = mainplotinfo.plotgroup;
        var xId = id + '-x';
        var yId = id + '-y';

        // now make the components of overlaid subplots
        // overlays don't have backgrounds, and append all
        // their other components to the corresponding
        // extra groups of their main plots.

        plotinfo.gridlayer = mainplotinfo.gridlayer;
        plotinfo.zerolinelayer = mainplotinfo.zerolinelayer;

        joinLayer(mainplotinfo.overlinesBelow, 'path', xId);
        joinLayer(mainplotinfo.overlinesBelow, 'path', yId);
        joinLayer(mainplotinfo.overaxesBelow, 'g', xId);
        joinLayer(mainplotinfo.overaxesBelow, 'g', yId);

        plotinfo.plot = joinLayer(mainplotinfo.overplot, 'g', id);

        joinLayer(mainplotinfo.overlinesAbove, 'path', xId);
        joinLayer(mainplotinfo.overlinesAbove, 'path', yId);
        joinLayer(mainplotinfo.overaxesAbove, 'g', xId);
        joinLayer(mainplotinfo.overaxesAbove, 'g', yId);

        // set refs to correct layers as determined by 'abovetraces'
        plotinfo.xlines = mainplotgroup.select('.overlines-' + xLayer).select('.' + xId);
        plotinfo.ylines = mainplotgroup.select('.overlines-' + yLayer).select('.' + yId);
        plotinfo.xaxislayer = mainplotgroup.select('.overaxes-' + xLayer).select('.' + xId);
        plotinfo.yaxislayer = mainplotgroup.select('.overaxes-' + yLayer).select('.' + yId);
    }

    joinLayer(plotinfo.gridlayer, 'g', plotinfo.xaxis._id, plotinfo.xaxis._id);
    joinLayer(plotinfo.gridlayer, 'g', plotinfo.yaxis._id, plotinfo.yaxis._id);
    plotinfo.gridlayer.selectAll('g').sort(axisIds.idSort);

    // common attributes for all subplots, overlays or not

    for(var i = 0; i < constants.traceLayerClasses.length; i++) {
        joinLayer(plotinfo.plot, 'g', constants.traceLayerClasses[i]);
    }

    plotinfo.xlines
        .style('fill', 'none')
        .classed('crisp', true);

    plotinfo.ylines
        .style('fill', 'none')
        .classed('crisp', true);
}

function purgeSubplotLayers(layers, fullLayout) {
    if(!layers) return;

    var overlayIdsToRemove = {};

    layers.each(function(subplotId) {
        var plotgroup = d3.select(this);
        var clipId = 'clip' + fullLayout._uid + subplotId + 'plot';

        plotgroup.remove();
        fullLayout._draggers.selectAll('g.' + subplotId).remove();
        fullLayout._defs.select('#' + clipId).remove();

        overlayIdsToRemove[subplotId] = true;

        // do not remove individual axis <clipPath>s here
        // as other subplots may need them
    });

    // must remove overlaid subplot trace layers 'manually'

    var subplots = fullLayout._plots;
    var subplotIds = Object.keys(subplots);

    for(var i = 0; i < subplotIds.length; i++) {
        var subplotInfo = subplots[subplotIds[i]];
        var overlays = subplotInfo.overlays || [];

        for(var j = 0; j < overlays.length; j++) {
            var overlayInfo = overlays[j];

            if(overlayIdsToRemove[overlayInfo.id]) {
                overlayInfo.plot.selectAll('.trace').remove();
            }
        }
    }
}

function joinLayer(parent, nodeType, className, dataVal) {
    var layer = parent.selectAll('.' + className)
        .data([dataVal || 0]);

    layer.enter().append(nodeType)
        .classed(className, true);

    return layer;
}

exports.toSVG = function(gd) {
    var imageRoot = gd._fullLayout._glimages;
    var root = d3.select(gd).selectAll('.svg-container');
    var canvases = root.filter(function(d, i) {return i === root.size() - 1;})
        .selectAll('.gl-canvas-context, .gl-canvas-focus');

    function canvasToImage() {
        var canvas = this;
        var imageData = canvas.toDataURL('image/png');
        var image = imageRoot.append('svg:image');

        image.attr({
            xmlns: xmlnsNamespaces.svg,
            'xlink:href': imageData,
            preserveAspectRatio: 'none',
            x: 0,
            y: 0,
            width: canvas.width,
            height: canvas.height
        });
    }

    canvases.each(canvasToImage);
};
