/*
 * spa.model.js
 * Model module
*/

/*jslint
	browser: true, 	continue: true, devel: true,
	indent: 2, 		maxerr: 50, 	newcap: true,
	newcap: true,	nomen: true,	plusplus: true,
	regexp: true,	sloppy: true,	vars: false,
	white: true
*/

/*global TAFFY, $, spa */

spa.model = (function () { 
  'use strict';
  
  var configMap = { anon_id: 'a0' };
  
  var stateMap = {
    anon_user: null,
    cid_serial: 0,
    people_cid_map: {},
    people_db: TAFFY(),
    user: null,
    is_connected: false
  };
  
  var isFakeData = false;

  var personProto = {
    get_is_user: function() {
      return this.cid === stateMap.user.cid;
    },
    get_is_anon: function() {
      return this.cid === stateMap.anon_user.cid;
    }
  };
  
  var makeCid = function() {
    return 'c' + String(stateMap.cid_serial++);
  };
  
  var clearPeopleDb = function() {
    var user = stateMap.user;
    stateMap.people_db = TAFFY();
    stateMap.people_cid_map = {};
    if (user) {
      stateMap.people_db.insert(user);
      stateMap.people_cid_map[user.cid] = user;
    }
  };
  
  var completeLogin = function(user_list) {
    var user_map = user_list[0];
    delete stateMap.people_cid_map[user_map.cid];
    stateMap.user.cid = user_map._id;
    stateMap.user.id = user_map._id;
    stateMap.user.css_map = user_map.css_map;
    stateMap.people_cid_map[user_map._id] = stateMap.user;
    chat.join();
    $.gevent.publish('spa-login', [stateMap.user]);
  };
  
  var makePerson = function(person_map) {
    var cid     = person_map.cid;
    var css_map = person_map.css_map;
    var id      = person_map.id;
    var name    = person_map.name;
    
    if (cid === undefined || !name) {
      throw 'client id and name required';
    }
    
    var person = Object.create(personProto);
    person.cid = cid;
    person.name = name;
    person.css_map = css_map;
    
    if (id) person.id = id;
    
    stateMap.people_cid_map[cid] = person;
    
    stateMap.people_db.insert(person);
    return person;
  };
  
  var removePerson = function(person) {
    if (!person) return false;
    // can't remove anonymous person
    if (person.id === configMap.anon_id) return false;
    stateMap.people_db({ cid: person.cid }).remove();
    if (person.cid) {
      delete stateMap.people_cid_map[person.cid];
    }
    return true;
  };
  
  ////////////////////////////////////////////////////////////
  // #people
  ////////////////////////////////////////////////////////////
  var people = (function() {
    
    var get_by_cid = function(cid) {
      return stateMap.people_cid_map[cid];
    };
    
    var get_db = function() { 
      return stateMap.people_db;
    };
    
    var get_user = function() { 
      return stateMap.user;
    };
    
    var login = function(name) {
      var sio = isFakeData ? spa.fake.mockSio : spa.data.getSio();
      stateMap.user = makePerson({
        cid: makeCid(),
        css_map: { top: 25, left: 25, 'background-color': '#8f8' },
        name: name
      });
      sio.on('userupdate', completeLogin);
      sio.emit('adduser', {
        cid: stateMap.user.cid,
        css_map: stateMap.user.css_map,
        name: stateMap.user.name
      });
    };
    
    var logout = function() {
      var user = stateMap.user;
      chat.leave();
      stateMap.user = stateMap.anon_user;
      clearPeopleDb();
      $.gevent.publish('spa-logout', [user]);
    };
    
    return {
      get_by_cid: get_by_cid,
      get_db: get_db,
      get_user: get_user,
      login: login,
      logout: logout
    };
  }());
  // end people
  
  ////////////////////////////////////////////////////////////
  // #chat
  ////////////////////////////////////////////////////////////
  var chat = (function() {
    
    var chatee = null;
    
    var _update_list = function(arg_list) {
      var people_list = arg_list[0];
      var is_chatee_online = false;
      clearPeopleDb();
      PERSON: for (var i = 0; i < people_list.length; i++) {
        var person_map = people_list[i];
        if (!person_map.name) continue PERSON;
        // if user defined, update css_map and skip remainder
        if (stateMap.user && stateMap.user.id === person_map.id) {
          stateMap.user.css_map = person_map.css_map;
          continue PERSON;
        }
        var make_person_map = {
          cid:      person_map._id,
          css_map:  person_map.css_map,
          id:       person_map._id,
          name:     person_map.name
        };
        var person = makePerson(make_person_map);
        if (chatee && chatee.id === make_person_map.id) {
          is_chatee_online = true;
          chatee = person;
        }
      }
      stateMap.people_db.sort('name');
      // if chatee is no longer online, we unset the chatee
      // which triggers the 'spa-setchatee' global event
      if (chatee && !is_chatee_online) set_chatee('');
    };
    
    var _publish_listchange = function(arg_list) {
      _update_list(arg_list);
      $.gevent.publish('spa-listchange', [arg_list]);
    };
    
    var _publish_updatechat = function(arg_list) {
      var msg_map = arg_list[0];
      if (!chatee || (
        msg_map.sender_id !== stateMap.user.id && 
        msg_map.sender_id !== chatee.id)) {
        set_chatee(msg_map.sender_id);  
      }
      $.gevent.publish('spa-updatechat', [msg_map]);
    };
    
    var leave_chat = function() {
      var sio = isFakeData ? spa.fake.mockSio : spa.data.getSio();
      chatee = null;
      stateMap.is_connected = false;
      if (sio) sio.emit('leavechat');
    };
    
    var get_chatee = function(){
      return chatee;
    };
    
    var join_chat = function() {
      if (stateMap.is_connected) return false;
      if (stateMap.user.get_is_anon()) {
        console.warn('User must be defined before joining chat');
        return false;
      }
      var sio = isFakeData ? spa.fake.mockSio : spa.data.getSio();
      sio.on('listchange', _publish_listchange);
      sio.on('updatechat', _publish_updatechat);
      stateMap.is_connected = true;
      return true;
    };
    
    var send_msg = function(msg_text) {
      var sio = isFakeData ? spa.fake.mockSio : spa.data.getSio();
      if (!sio) return false;
      if (!stateMap.user || !chatee) return false;
      var msg_map = {
        dest_id:   chatee.id,
        dest_name: chatee.name,
        sender_id: stateMap.user.id,
        msg_text:  msg_text
      };
      // we publish updatechat so we can show our outgoing msgs
      _publish_updatechat([msg_map]);
      sio.emit('updatechat', msg_map);
      return true;
    };
    
    var set_chatee = function(person_id) {
      var new_chatee = stateMap.people_cid_map[person_id];
      if (new_chatee && chatee && chatee.id === new_chatee.id) {
        return false;
      }
      else if (!new_chatee) {
        new_chatee = null;
      }
      $.gevent.publish('spa-setchatee', {
        old_chatee: chatee,
        new_chatee: new_chatee
      });
      chatee = new_chatee;
      return true;
    };
    
    var update_avatar = function(avatar_update_map) {
      var sio = isFakeData ? spa.fake.mockSio : spa.data.getSio();
      if (sio) {
        sio.emit('updateavatar', avatar_update_map);
      }
    };
    
    return {
      leave:      leave_chat,
      join:       join_chat,
      get_chatee: get_chatee,
      set_chatee: set_chatee,
      send_msg:   send_msg,
      update_avatar: update_avatar
    };
  }());
  // end chat
  
  var initModule = function() {
    // initialize anonymous person
    stateMap.anon_user = makePerson({
      cid: configMap.anon_id,
      id: configMap.anon_id,
      name: 'anonymous'
    });
    stateMap.user = stateMap.anon_user;
  };
  
  return {
    initModule: initModule,
    chat:       chat,
    people:     people
  };
}());







