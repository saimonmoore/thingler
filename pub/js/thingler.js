//
// ~ thingler.js ~
//
var path   = window.location.pathname;
var id     = path.slice(1);
var xhr    = new(pilgrim.Client)({ extension: '.json' });
var input  = document.getElementById('new');
var title  = document.getElementById('title');
var list   = document.getElementById('list');
var about  = document.getElementById('about');
var create = document.getElementById('create');
var header = document.querySelector('header');
var footer = document.querySelector('footer');
var hash   = window.location.hash;

var lock            = document.getElementById('lock');
var passwordProtect = document.getElementById('password-protect');
var authenticate    = document.getElementById('password-authenticate');

var room = {
    rev: null,
    locked: false,
    doc: null,
    localStorage: new Lawnchair({adaptor:'dom', keyName: '_id'}),
    changes: {
        localStorage: new Lawnchair({adaptor:'dom', keyName: 'id'}),
        data:  [],
        rollback: function (changes) {
            this.data = changes.concat(this.data);
            this.localStorage.save({id: 'changes', changes: this.data});
        },
        push: function (type, id, change, callback) {
            change          = change || {};
            change.type     = type;
            change.id       = id && parseInt(id);
            change.ctime    = Date.now() - new(Date)(room.doc.timestamp);
            change.callback = callback;

            this.data.push(change);

            //replay onto doc
            doc_handlers[change.type](room.doc, change);

            //save doc to localStorage
            room.localStorage.save(room.doc);

            //save changes to localStorage
            this.localStorage.save({id: 'changes', changes: this.data});

            // If we're inserting, sync the change right away.
            // Else, let it happen on the next tick.
            if (type === 'insert' || type === 'lock') {
                clock.tick();
            }
        },
        commit: function () {
            var commit = this.data;
            this.data = [];
            this.localStorage.save({id: 'changes', changes: this.data});
            return commit;
        },
        replayLocalChanges: function() {
          this.localStorage.get('changes', function(data) {
            //replay changes to update UI
            if (data && data.changes) {
              data.changes.forEach(function (change) {
                ui_handlers[change.type](change);
                //call change's callback if any
                change.callback && change.callback();
              });
            }
          });
        }
    },
    initialize: function (doc) {
        if (doc && doc._rev) {
          // Initialize title and revision number
          room.rev = doc._rev && parseInt(doc._rev.match(/^(\d+)/)[1]);
          doc.rev = room.rev;
          room.doc = doc;
          setTitle(doc.title);

          if (doc.locked) {
              lock.addClass('locked');
              room.locked = true;
          }
          header.style.display = 'block';

          // Initialize list
          doc.items && doc.items.forEach(function (item) {
              list.appendChild(createItem(item));
          });

          handleTagFilter(hash);
          dom.sortable(list, handleSort);

          footer.style.visibility = 'visible'

          // Before shutdown, do one last sync
          window.onbeforeunload = function (e) {
              clock.tick(true);
          };

          //restore any offline changes
          room.changes.localStorage.get('changes', function(data) {
            if (data && data.changes) {
              room.changes.data = data.changes;
            }
          });

          //
          // Start the Clock
          //
          clock.init(function (clock, last) {
              var changes = room.changes.commit();
              xhr.resource(id)[last ? 'postSync' : 'post']({
                  rev:     room.rev || 0,
                  changes: changes,
                  last:    last
              }, function (err, doc) {
                  if (err || (doc && !doc.commits)) {
                      if (err && err.status !== 404) { log(err) }
                      room.changes.rollback(changes);
                      clock.synchronised();
                  } else if (doc && doc.commits) {
                      room.rev = doc.rev || 0;
                      room.doc.rev = room.rev;
                      if (doc.commits.length > 0) {
                          doc.commits.forEach(function (commit) {
                              commit.changes.forEach(function (change) {
                                  ui_handlers[change.type](change);

                                  //We don't get the actual doc back, just the changes, so we
                                  //also need to replay the changes to the local doc (and save to localStorage)
                                  //so the next time the app is opened (while offline) we still have the right data
                                  doc_handlers[change.type](room.doc, change);
                              });
                          });

                          room.localStorage.save(room.doc);
                          clock.activity();
                      }
                  }
                  clock.synchronised();
                  changes.forEach(function (change) {
                      change.callback && change.callback();
                  });
              });
          });
        }

    }
};

//
// The Great Synchronization Clock
//
var clock = {
    timer: null,
    interval: 1000,
    synchronising: false,
    init: function (callback) {
        this.callback = callback;
        this.reset(1000);
    },
    //
    // Creates a new timer based the interval
    // passed.
    //
    reset: function (interval) {
        // One hour maximum interval
        this.interval = Math.min(interval, 3600000);

        if (this.timer)   { clearInterval(this.timer) }
        if (this.timeout) { clearTimeout(this.timeout) }

        this.timer = setInterval(function () {
            clock.tick();
        }, this.interval);

        // In `this.interval * 4` milliseconds,
        // double the interval.
        // Note that this could never happen,
        // if a `reset` is executed within that time.
        this.timeout = setTimeout(function () {
            clock.reset(clock.interval * 2);
        }, this.interval * 4);
    },
    //
    // Called on every interval tick.
    //
    tick: function (arg) {
        //cancel sync if offline (only for browsers that support this)
        if (!navigator.onLine) return;
        if (! this.synchronising) {
            this.synchronising = true;
            this.callback(this, arg);
        }
    },

    synchronised: function () {
        this.synchronising = false;
    },
    //
    // Called on inbound & outbound activity.
    // We either preserve the current interval length,
    // if it's the shortest possible, or divide it by four.
    //
    activity: function () {
        if (this.interval < 4000) {
            this.reset(1000);
        } else {
            this.reset(this.interval / 4);
        }
        return true;
    }
};

var titleHasFocus = false;
var tagPattern = /\B#[a-zA-Z0-9_-]+\b/g;

dom.tokenizing(input, input.parentNode, tagPattern).on('new', function (e) {
    var tokens  = this.parentNode.querySelector('.tokens'),
        title   = parseTitle(this.value),
        item    = { title: title, tags: e.tokens.concat(hash.length > 1 ? [hash] : []) },
        element = ui_handlers.insert(item),
        id      = parseInt(element.firstChild.getAttribute('data-id'));

    tokens.innerHTML = '';
    this.value       = '';
    this.focus();

    room.changes.push('insert', id, item);
}, false);

input.parentNode.on('focus', function () { this.addClass('focused') })
                .on('blur',  function () { this.removeClass('focused') });

function parseTitle(str) {
    return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&/, '&amp;').trim();
}

//
// Handle title changes
//
title.onfocus = function (e) {
    titleHasFocus = true;
};
title.onkeydown = function (e) {
    if (e.keyCode === 13) {
        title.blur();
        return false;
    }
};
title.onblur = function (e) {
    titleHasFocus = false;
    setTitle(title.value);
    room.changes.push('title', null, { value: title.value });
};

function go(page) {
    document.getElementById(page).style.display = 'block';
    if (page === 'page') { input.focus() }
}



var ui_handlers = {
    insert: function (change) {
        var item = createItem(change);
        list.insertBefore(item, list.firstChild);
        dom.sortable(list, handleSort);
        dom.flash(item);
        return item;
    },
    title: function (change) {
        setTitle(change.value);
        dom.flash(title);
    },
    edit: function (change) {
        var element = find(change.id);
        refreshItem(element, { title: change.title, tags: change.tags });
        dom.flash(element);
    },
    check: function (change) {
        var element = find(change.id);
        element.querySelector('[type="checkbox"]').checked = true;
        element.setAttribute('class', 'completed');
        dom.flash(element);
    },
    uncheck: function (change) {
        var element  = find(change.id),
            checkbox = element.querySelector('[type="checkbox"]');

        checkbox.checked  = false;
        checkbox.disabled = false;
        element.setAttribute('class', '');
        dom.flash(element);
    },
    remove: function (change) {
        var element = find(change.id);
        element && list.removeChild(element.parentNode);
    },
    sort: function (change) {
        var elem  = find(change.id).parentNode,
            index = elem.parentNode.children.indexOf(elem),
            ref   = list.children[change.to];

        if (change.to > index) {
            if (!ref || change.to === list.children.length - 1) {
                list.appendChild(elem);
            } else {
                list.insertBefore(elem, ref.nextSibling);
            }
        } else {
            list.insertBefore(elem, ref);
        }
        dom.flash(elem);
    },
    lock: function (change) {
        lock.addClass('locked');
        room.locked = true;
    },
    unlock: function (change) {
        lock.removeClass('locked');
        room.locked = false;
    }
};

var doc_handlers = {
    insert: function (doc, change) {
        if ((doc.items.length + 1) < 256) {
            if (! Array.isArray(change.tags)) { return }
            doc.items.unshift({
                id:    change.id,
                title: change.title,
                tags:  change.tags
            });
        }
    },
    title: function (doc, change) {
        doc.title = change.value;
    },
    edit: function (doc, change) {
        var item = findInDoc(change.id, doc);
        if (item) {
            item.title = change.title;
            item.tags = change.tags;
        }
    },
    sort: function (doc, change) {
        var index = indexOf(change.id, doc), item;
        if (index !== -1) {
            item = doc.items.splice(index, 1)[0];
            doc.items.splice(change.to, 0, item);
        }
    },
    check: function (doc, change) {
        var item = findInDoc(change.id, doc);
        if (item) {
            item.completed = ((typeof doc.timestamp === 'string') ? new Date(doc.timestamp) : doc.timestamp).getTime() + change.ctime;
        }
    },
    uncheck: function (doc, change) {
        var item = findInDoc(change.id, doc);
        if (item) {
            delete(item.completed);
        }
    },
    remove: function (doc, change) {
        var index = indexOf(change.id, doc);
        if (index !== -1) {
            doc.items.splice(index, 1);
        }
    },
    lock: function (doc, change) {
        doc.password = change.password;
    },
    unlock: function (doc, change) {
        doc.password = null;
    }
};


document.querySelector('[data-action="about"]').onclick = function () {
    if (about.style.display !== 'block') {
        about.style.display = 'block';
    } else {
        dom.hide(about);
    }
    return false;
};

document.querySelector('[data-action="close"]').onclick = function () {
    dom.hide(this.parentNode.parentNode);
    return false;
};

lock.onclick = function () {
    var input = passwordProtect.querySelector('input');

    if (room.locked) {
        room.changes.push('unlock', null, {});
        ui_handlers.unlock();
    } else {
        input.disabled = false;
        input.removeClass('disabled');
        passwordProtect.style.display = 'block';
        input.focus();
        input.onkeydown = function (e) {
            if (e.keyCode === 13 && input.value) {
                input.disabled = true;
                input.addClass('disabled');
                room.changes.push('lock', null, { password: input.value }, function () {
                    dom.hide(passwordProtect);
                });
                ui_handlers.lock();
                return false;
            }
        };
    }
    return false;
};

//
// Find an item by `title`
//
function find(id) {
    return list.querySelector('[data-id="' + id + '"]');
}

function findInDoc(id, doc) {
    for (var i = 0; i < doc.items.length; i++) {
        if (doc.items[i].id === id) {
            return doc.items[i];
        }
    }
    return null;
}

function indexOf(id, doc) {
    for (var i = 0; i < doc.items.length; i++) {
        if (doc.items[i].id === id) {
            return i;
        }
    }
    return -1;
}

function createItem(item) {
    var template = document.getElementById('todo-template');
    var e        = dom.createElement('li'),
        clone    = template.cloneNode(true),
        remove   = clone.querySelector('a[data-action="remove"]'),
        edit     = clone.querySelector('a[data-action="edit"]'),
        checkbox = clone.querySelector('input[type="checkbox"]'),
        input    = clone.querySelector('input[type=text]');

    if (item.completed) {
        checkbox.checked  = true;
        checkbox.disabled = true;
        clone.setAttribute('class', 'completed');
    }

    clone.id = '';
    clone.setAttribute('style', '');

    if (! ('id' in item)) {
        item.id = Date.now() - new(Date)(room.doc.timestamp);
    }

    refreshItem(clone, item);

    e.appendChild(clone);

    // Remove Item
    remove.onclick = function () {
        list.removeChild(e);
        room.changes.push('remove', item.id);
        return false;
    };

    //
    // Edit Item
    //
    // We return `false` from `onmousedown` to stop
    // `onblur` from triggering.
    //
    edit.onmousedown = function (e) { return false };
    edit.onclick     = function (e) {
        handleEdit(clone);
        return false;
    };

    dom.tokenizing(input, e, tagPattern);

    input.addEventListener('new',     handleEditSave, false);
    input.addEventListener('blurall', handleEditSave, false);

    // Check Item
    checkbox.addEventListener('click', function () {
        if (this.checked) {
            room.changes.push('check', item.id);
            clone.setAttribute('class', 'completed');
        } else {
            room.changes.push('uncheck', item.id);
            clone.removeAttribute('data-completed');
            clone.setAttribute('class', '');
        }
    }, false);

    return e;
}

function refreshItem(element, item) {
    var tagList = element.querySelector('ul.tags');
    var label   = element.querySelector('label');

    tagList.innerHTML = '';

    for (var k in item) {
        element.setAttribute('data-' + k, Array.isArray(item[k]) ?
                              item[k].join(' ') : item[k]);
    }

    if (item.tags) {
        item.tags.forEach(function (tag) {
            var a  = dom.createElement('a', { href: tag }, tag),
                li = dom.createElement('li');

            if (! tagList.querySelector('[data-tag="' + tag + '"]')) {
                li.setAttribute('data-tag', tag);
                li.appendChild(a);
                a.onclick = function () {
                    if (window.location.hash === tag) {
                        window.location.hash = '';
                        return false;
                    }
                };
                tagList.appendChild(li);
            }
        });
    }
    label.innerHTML = markup(item.title);
}
function markup(str) {
    return str.replace(/\*\*((?:\\\*|\*[^*]|[^*])+)\*\*/g, function (_, match) {
        return '<strong>' + match.replace(/\\\*\*/g, '*') + '</strong>';
    }).replace(/\*((?:\\\*|[^*])+)\*/g, function (_, match) {
        return '<em>' + match.replace(/\\\*/g, '*') + '</em>';
    }).replace(/\b_((?:\\\_|[^_])+)_\b/g, function (_, match) {
        return '<em>' + match.replace(/\\_/g, '_') + '</em>';
    }).replace(/`((?:\\`|[^`])+)`/g, function (_, match) {
        return '<code>' + match.replace(/\\`/g, '`') + '</code>';
    }).replace(/(http:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
}

function handleSort(id, to) {
    return room.changes.push('sort', id, { to: to });
}
function handleTagFilter(filter) {
    var child, tag, tags;

    Array.prototype.slice.call(list.querySelectorAll('li.active')).forEach(function (e) {
        e.removeClass('active');
    });

    list.children.forEach(function (child) {
        if (filter) {
            tag = child.querySelector('[data-tag="' + filter + '"]');
            tags = child.firstChild.getAttribute('data-tags');

            if (tags && (tags.split(' ').indexOf(filter) !== -1)) {
                tag.addClass('active');
                dom.show(child);
            } else {
                dom.hide(child);
            }
        } else {
            tag && tag.removeClass('active');
            dom.show(child);
        }
    });
}
function handleEdit(element) {
    var label  = element.querySelector('label'),
        tags   = element.getAttribute('data-tags'),
        field  = element.querySelector('input[type="text"]'),
        li     = element.parentNode,
        check  = element.querySelector('input[type="checkbox"]'),
        tokens = element.querySelector('.tokens');

    li.style.cursor = 'text';

    if (li.hasClass('editing')) {
        handleEditSave.call(field, { tokens: dom.tokenizing.parseTokens(tokens) });
    } else {
        check.disabled = false;
        li.addClass('editing');
        dom.show(tokens), dom.hide(label), dom.show(field);
        if (tags) {
            dom.tokenizing.createTokens.call(field.tokenizer, tags.split(' '));
            tokens.lastChild.lastChild.focus();
        } else {
            field.focus();
        }
        field.value = element.getAttribute('data-title');
        field.autosize();
    }
}
function handleEditSave(e) {
    if (! this.parentNode.parentNode.hasClass('editing')) { return }

    var div    = this.parentNode,
        tokens = div.querySelector('.tokens'),
        tags   = div.getAttribute('data-tags'),
        id     = div.getAttribute('data-id'),
        check  = div.querySelector('input[type="checkbox"]'),
        label  = div.querySelector('label');

    var item = {
        title: parseTitle(this.value),
        tags: e.tokens
    };

    div.parentNode.style.cursor = '';

    var old = div.getAttribute('data-title');

    div.getAttribute('data-completed') && (check.disabled = true);

    div.parentNode.removeClass('editing');
    dom.hide(this), dom.show(label);

    // Only push a change if something actually changed.
    if (item.title !== old || item.tags.join(' ') !== tags) {
        room.changes.push('edit', id, item);
        refreshItem(div, item);
    }
    dom.hide(tokens);
};

function setTitle(str) {
    title.value = str;
    document.title = 'Thingler · ' + str;
}

if (navigator.onLine) {
  //get doc from the server on page load
  xhr.resource(id).get(function (err, doc) {
      var password = authenticate.querySelector('input');
      if (err && err.status === 404) {
          go('not-found');
          if (id.match(/^[a-zA-Z0-9-]+$/)) {
              create.onclick = function () {
                  xhr.resource(id).put(function (e, doc) {
                      if (e) {

                      } else {
                          go('page');
                          dom.hide(document.getElementById('not-found'));
                          room.initialize(doc);
                          room.changes.replayLocalChanges();
                          room.localStorage.save(doc);
                      }
                  });
                  return false;
              };
          } else {
              dom.hide(create);
          }
      } else if (err && err.status === 401) {
          authenticate.style.display = 'block';
          password.focus();
          password.onkeydown = function (e) {
              var that = this;
              if (e.keyCode === 13) {
                  password.addClass('disabled');
                  password.disabled = true;
                  xhr.resource(id).path('session')
                     .post({ password: this.value }, function (e, doc) {
                         if (e) {
                             that.addClass('error');
                             password.removeClass('disabled');
                             password.disabled = false;
                         } else {
                             xhr.resource(id).get(function (e, doc) {
                                 go('page');
                                 room.initialize(doc);
                                 room.changes.replayLocalChanges();
                                 dom.hide(authenticate);
                                 room.localStorage.save(doc);
                             });
                         }
                     });
              }
          };
      } else if (err || !doc._rev) {
        //retrieve doc from local storage
        room.localStorage.get(id, function(doc) {
          go('page');
          room.initialize(doc);
        });
      } else {
          go('page');
          room.initialize(doc);
          room.changes.replayLocalChanges();
          room.localStorage.save(doc);
      }
  });
}
else {
  //retrieve doc from local storage
  room.localStorage.get(id, function(doc) {
    go('page');
    room.initialize(doc);
  });
}


//
// Check the hashtag every 10ms, for changes
//
setInterval(function () {
    if (window.location.hash !== hash) {
        hash = window.location.hash;
        handleTagFilter(hash);
    }
}, 10);

