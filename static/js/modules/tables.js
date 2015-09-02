'use strict';

/* global require, module, window, document, API_LOCATION, API_VERSION, API_KEY */

var $ = require('jquery');
var URI = require('URIjs');
var _ = require('underscore');
var moment = require('moment');
var tabs = require('../vendor/tablist');

require('datatables');
require('drmonty-datatables-responsive');

var filters = require('./filters');
var helpers = require('./helpers');

var simpleDOM = 't<"results-info"ip>';

$.fn.DataTable.Api.register('seekIndex()', function(length, start, value) {
  var settings = this.context[0];

  // Clear stored indexes on filter change
  if (!_.isEqual(settings._parsedFilters, parsedFilters)) {
    settings._seekIndexes = {};
  }
  settings._parsedFilters = _.clone(parsedFilters);

  // Set or get stored indexes
  if (typeof value !== 'undefined') {
    settings._seekIndexes = settings._seekIndexes || {};
    settings._seekIndexes[length] = settings._seekIndexes[length] || {};
    settings._seekIndexes[length][start] = value;
  } else {
    return ((settings._seekIndexes || {})[length] || {})[start] || undefined;
  }
});

function yearRange(first, last) {
  if (first === last) {
    return first;
  } else {
    return first.toString() + ' - ' + last.toString();
  }
}

function mapFilters(filters) {
  return _.reduce(filters, function(acc, val) {
    if (val.value && val.name.slice(0, 1) !== '_') {
      if (acc[val.name]) {
        acc[val.name].push(val.value);
      } else {
        acc[val.name] = [val.value];
      }
    }
    return acc;
  }, {});
}

var parsedFilters;

function buildCycle(datum) {
  if (parsedFilters && parsedFilters.cycle) {
    var cycles = _.intersection(
      _.map(parsedFilters.cycle, function(cycle) {return parseInt(cycle);}),
      datum.cycles
    );
    return '?cycle=' + _.max(cycles);
  } else {
    return '';
  }
}

function buildEntityLink(data, url, category) {
  var anchor = document.createElement('a');
  anchor.textContent = data;
  anchor.setAttribute('href', url);
  anchor.setAttribute('title', data);
  anchor.setAttribute('data-category', category);
  anchor.classList.add('single-link');
  return anchor.outerHTML;
}

function buildAggregateUrl(uri, cycle) {
  var dates = helpers.cycleDates(cycle);
  return uri.addQuery({
    min_date: dates.min,
    max_date: dates.max
  }).toString();
}

function buildTotalLink(path, getParams) {
  return function(data, type, row, meta) {
    var span = document.createElement('div');
    span.setAttribute('data-value', data);
    span.setAttribute('data-row', meta.row);
    var link = document.createElement('a');
    link.textContent = helpers.currency(data);
    link.setAttribute('title', 'View individual transactions');
    var uri = URI(path)
      .query({committee_id: row.committee_id})
      .addQuery(getParams(row));
    link.setAttribute('href', buildAggregateUrl(uri, row.cycle));
    span.appendChild(link);
    return span.outerHTML;
  };
}

function formattedColumn(formatter) {
  return function(opts) {
    return _.extend({
      render: function(data, type, row, meta) {
        return formatter(data);
      }
    }, opts);
  };
}

function barColumn(formatter) {
  formatter = formatter || function(value) { return value; };
  return function(opts) {
    return _.extend({
      render: function(data, type, row, meta) {
        var span = document.createElement('div');
        span.textContent = formatter(data);
        span.setAttribute('data-value', data);
        span.setAttribute('data-row', meta.row);
        return span.outerHTML;
      }
    }, opts);
  };
}

function urlColumn(attr, opts) {
  return _.extend({
    render: function(data, type, row, meta) {
      var anchor = document.createElement('a');
      anchor.textContent = data;
      anchor.setAttribute('href', row[attr]);
      anchor.setAttribute('target', '_blank');
      return anchor.outerHTML;
    }
  }, opts);
}

var dateColumn = formattedColumn(helpers.datetime);
var currencyColumn = formattedColumn(helpers.currency);
var barCurrencyColumn = barColumn(helpers.currency);

var candidateColumn = formattedColumn(function(data) {
  if (data) {
    return buildEntityLink(data.name, '/candidate/' + data.candidate_id, 'candidate');
  } else {
    return '';
  }
});

var committeeColumn = formattedColumn(function(data) {
  if (data) {
    return buildEntityLink(data.name, '/committee/' + data.committee_id, 'committee');
  } else {
    return '';
  }
});

function mapSort(order, columns) {
  return _.map(order, function(item) {
    var name = columns[item.column].data;
    if (item.dir === 'desc') {
      name = '-' + name;
    }
    return name;
  });
}

function mapResponse(response) {
  return {
    recordsTotal: response.pagination.count,
    recordsFiltered: response.pagination.count,
    data: response.results
  };
}

function ensureArray(value) {
  return _.isArray(value) ? value : [value];
}

function compareQuery(first, second) {
  var keys = _.keys(first);
  if (!_.isEqual(keys.sort(), _.keys(second).sort())) {
    return false;
  }
  var different = _.find(keys, function(key) {
    return !_.isEqual(
      ensureArray(first[key]).sort(),
      ensureArray(second[key]).sort()
    );
  });
  return !different;
}

function pushQuery(params) {
  var query = URI.parseQuery(window.location.search);
  if (!compareQuery(query, params)) {
    // Clear and update filter fields
    _.each(filters.getFields(), function(field) {
      delete query[field];
    });
    params = _.extend(query, params);
    var queryString = URI('').query(params).toString();
    window.history.pushState(params, queryString, queryString || window.location.pathname);
  }
}

function mapQueryOffset(api, data) {
  return {
    per_page: data.length,
    page: Math.floor(data.start / data.length) + 1,
  };
}

function mapQuerySeek(api, data) {
  var indexes = api.seekIndex(data.length, data.start) || {};
  return _.extend(
    {per_page: data.length},
    _.chain(Object.keys(indexes))
      .filter(function(key) { return indexes[key]; })
      .map(function(key) { return [key, indexes[key]]; })
      .object()
      .value()
  );
}

function identity(value) {
  return value;
}

var MODAL_TRIGGER_CLASS = 'js-modal-trigger';
var MODAL_TRIGGER_HTML = '<i class="icon arrow--right ' + MODAL_TRIGGER_CLASS + '"></li>';

function modalRenderFactory(template, fetch) {
  fetch = fetch || identity;
  return function(api, data, response) {
    var $table = $(api.table().node());
    var $modal = $('#datatable-modal');

    // Move the modal to the results div.
    $modal.appendTo($table);
    $table.find('tr').attr('tabindex', 0);

    $table.on('click keypress', '.js-panel-toggle tr:has(.' + MODAL_TRIGGER_CLASS + ')', function(e) {
      if (e.which === 13 || e.type === 'click') {
        var $target = $(e.target);
        if ($target.is('a')) {
          return true;
        }
        if ( !$target.closest('td').hasClass('dataTables_empty') ) {
          var $row = $target.closest('tr');
          var index = api.row($row).index();
          $.when(fetch(response.results[index])).done(function(fetched) {
            $modal.find('.js-panel-content').html(template(fetched));
            $modal.attr('aria-hidden', 'false');
            $row.siblings().toggleClass('row-active', false);
            $row.toggleClass('row-active', true);
            $('body').toggleClass('panel-active', true);
            var hideColumns = api.columns('.hide-panel');
            hideColumns.visible(false);

            // Populate the pdf button if there is one
            if (fetched.pdf_url) {
              $modal.find('.js-pdf_url').attr('href', fetched.pdf_url);
            } else {
              $modal.find('.js-pdf_url').remove();
            }

            // Set focus on the close button
            $('.js-hide').focus();

            // When under $large-screen
            // TODO figure way to share these values with CSS.
            if ($(document).width() < 980) {
              api.columns('.hide-panel-tablet').visible(false);
            }
          });
        }
      }
    });

    $modal.on('click', '.js-panel-close', function(e) {
      e.preventDefault();
      hidePanel(api, $modal);
    });
  };
}

function hidePanel(api, $modal) {
    $('.row-active').focus();
    $('.js-panel-toggle tr').toggleClass('row-active', false);
    $('body').toggleClass('panel-active', false);
    $modal.attr('aria-hidden', 'true');
    api.columns('.hide-panel-tablet').visible(true);

    if ($(document).width() > 980) {
      api.columns('.hide-panel').visible(true);
    }

}

function barsAfterRender(template, api, data, response) {
  var $table = $(api.table().node());
  var $cols = $table.find('div[data-value]');
  var values = $cols.map(function(idx, each) {
    return parseFloat(each.getAttribute('data-value'));
  });
  var max = _.max(values);
  $cols.after(function() {
    var width = 100 * parseFloat($(this).attr('data-value')) / max;
    return $('<div>')
      .addClass('value-bar')
      .css('width', _.max([width, 1]) + '%');
  });
}

function handleResponseSeek(api, data, response) {
  api.seekIndex(data.length, data.length + data.start, response.pagination.last_indexes);
}

var defaultCallbacks = {
  preprocess: mapResponse
};

function updateOnChange($form, api) {
  function onChange(e) {
    e.preventDefault();
    hidePanel(api, $('#datatable-modal'));
    api.ajax.reload();
  }
  $form.on('change', 'input,select', _.debounce(onChange, 250));
}

/**
 * Adjust form height to match table; called after table redraw.
 */
function adjustFormHeight($table, $form) {
  $form.height('');
  var tableHeight = $table.closest('.datatable__container').height();
  var filterHeight = $form.height();
  if (tableHeight > filterHeight && $(document).width() > 980) {
    $form.height(tableHeight);
  }
}

var defaultCallbacks = {
  preprocess: mapResponse
};

function initTable($table, $form, baseUrl, baseQuery, columns, callbacks, opts) {
  var draw;
  var $processing = $('<div class="overlay is-loading"></div>');
  var $hideNullWidget = $(
    '<input id="null-checkbox" type="checkbox" name="sort_hide_null" checked>' +
    '<label for="null-checkbox" class="results-info__null">' +
      'Hide results with missing values when sorting' +
    '</label>'
  );
  var useFilters = opts.useFilters;
  var useHideNull = opts.hasOwnProperty('useHideNull') ? opts.useHideNull : true;
  callbacks = _.extend({}, defaultCallbacks, callbacks);
  opts = _.extend({
    serverSide: true,
    searching: false,
    columns: columns,
    lengthMenu: [30, 50, 100],
    responsive: {
      details: false
    },
    language: {
      lengthMenu: 'Results per page: _MENU_'
    },
    dom: '<"results-info results-info--top"lfrp><"panel__main"t><"results-info"ip>',
    ajax: function(data, callback, settings) {
      var api = this.api();
      if ($form) {
        var filters = $form.serializeArray();
        parsedFilters = mapFilters(filters);
        pushQuery(parsedFilters);
      }
      var query = _.extend(
        callbacks.mapQuery(api, data),
        {api_key: API_KEY},
        parsedFilters || {}
      );
      if (useHideNull) {
        query = _.extend(
          query,
          {sort_hide_null: $hideNullWidget.is(':checked')}
        );
      }
      query.sort = mapSort(data.order, columns);
      $processing.show();
      $.getJSON(
        URI(API_LOCATION)
        .path([API_VERSION, baseUrl].join('/'))
        .addQuery(baseQuery || {})
        .addQuery(query)
        .toString()
      ).done(function(response) {
        callbacks.handleResponse(api, data, response);
        callback(callbacks.preprocess(response));
        callbacks.afterRender(api, data, response);
      }).always(function() {
        $processing.hide();
      });
    }
  }, opts || {});
  var api = $table.DataTable(opts);
  callbacks = _.extend({
    handleResponse: function() {},
    afterRender: function() {}
  }, callbacks);
  if (useFilters) {
    // Update filters and data table on navigation
    $(window).on('popstate', function() {
      filters.activateInitialFilters();
      var tempFilters = mapFilters(filters);
      if (!_.isEqual(tempFilters, parsedFilters)) {
        api.ajax.reload();
      }
    });
  }
  // Prepare loading message
  $processing.hide();
  $table.before($processing);
  var $paging = $(api.table().container()).find('.results-info--top');
  if (useHideNull) {
    $paging.prepend($hideNullWidget);
  }
  $table.css('width', '100%');
  $table.find('tbody').addClass('js-panel-toggle');
  if ($form) {
    updateOnChange($form, api);
    $table.on('draw.dt', adjustFormHeight.bind(null, $table, $form));
  }
}

function initTableDeferred($table) {
  var args = _.toArray(arguments);
  tabs.onShow($table, function() {
    initTable.apply(null, args);
  });
}

var offsetCallbacks = {
  mapQuery: mapQueryOffset
};
var seekCallbacks = {
  mapQuery: mapQuerySeek,
  handleResponse: handleResponseSeek
};

module.exports = {
  simpleDOM: simpleDOM,
  yearRange: yearRange,
  buildCycle: buildCycle,
  buildAggregateUrl: buildAggregateUrl,
  buildTotalLink: buildTotalLink,
  buildEntityLink: buildEntityLink,
  candidateColumn: candidateColumn,
  committeeColumn: committeeColumn,
  currencyColumn: currencyColumn,
  urlColumn: urlColumn,
  barCurrencyColumn: barCurrencyColumn,
  dateColumn: dateColumn,
  barsAfterRender: barsAfterRender,
  modalRenderFactory: modalRenderFactory,
  MODAL_TRIGGER_CLASS: MODAL_TRIGGER_CLASS,
  MODAL_TRIGGER_HTML: MODAL_TRIGGER_HTML,
  offsetCallbacks: offsetCallbacks,
  seekCallbacks: seekCallbacks,
  initTable: initTable,
  initTableDeferred: initTableDeferred
};
