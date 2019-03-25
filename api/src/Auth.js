const bcrypt = require("bcrypt");
const passport = require("passport");
const validator = require("validator");
const EventEmitter = require("events");
const constants = require("../../common/constants");

class Auth extends EventEmitter {
  constructor(config, i18n, db, ws, mailer, pubsub, fake) {
    super();

    this.config = config;
    this.i18n = i18n;
    this.db = db;
    this.ws = ws;
    this.mailer = mailer;
    this.pubsub = pubsub;
    this.fake = fake;

    this.passport = passport;
  }

  // eslint-disable-next-line lodash/prefer-constant
  static get $provides() {
    return "auth";
  }

  // eslint-disable-next-line lodash/prefer-constant
  static get $requires() {
    return ["config", "i18n", "db", "ws", "mailer", "pubsub", "fake"];
  }

  // eslint-disable-next-line lodash/prefer-constant
  static get $lifecycle() {
    return "singleton";
  }

  /**
   * Facebook OAuth provider
   */
  get facebookProvider() {
    if (!this.config.facebookAuthId || !this.config.facebookAuthSecret)
      return null;

    return {
      providerName: constants.oauthProviders.FACEBOOK,
      providerOptions: {
        scope: ["email", "public_profile"]
      },
      Strategy: require("passport-facebook").Strategy,
      strategyOptions: {
        clientID: this.config.facebookAuthId,
        clientSecret: this.config.facebookAuthSecret
      }
    };
  }

  /**
   * Google OAuth provider
   */
  get googleProvider() {
    if (!this.config.googleAuthId || !this.config.googleAuthSecret) return null;

    return {
      providerName: constants.oauthProviders.GOOGLE,
      providerOptions: {
        scope: ["profile", "email"]
      },
      Strategy: require("passport-google-oauth").OAuth2Strategy,
      strategyOptions: {
        clientID: this.config.googleAuthId,
        clientSecret: this.config.googleAuthSecret
      }
    };
  }

  /**
   * Twitter OAuth provider
   */
  get twitterProvider() {
    if (!this.config.twitterAuthKey || !this.config.twitterAuthSecret)
      return null;

    return {
      providerName: constants.oauthProviders.TWITTER,
      providerOptions: {
        scope: []
      },
      Strategy: require("passport-twitter").Strategy,
      strategyOptions: {
        consumerKey: this.config.twitterAuthKey,
        consumerSecret: this.config.twitterAuthSecret,
        userProfileURL:
          "https://api.twitter.com/1.1/account/verify_credentials.json?include_email=true"
      }
    };
  }

  /**
   * NextAuth providers
   */
  get providers() {
    return _.compact([
      this.facebookProvider,
      this.googleProvider,
      this.twitterProvider
    ]);
  }

  async checkPassword(password, hash) {
    return new Promise((resolve, reject) => {
      bcrypt.compare(password, hash, (error, res) => {
        if (error) return reject(error);
        resolve(res);
      });
    });
  }

  async encryptPassword(password) {
    return new Promise((resolve, reject) => {
      bcrypt.hash(password, 10, (error, hash) => {
        if (error) return reject(error);
        resolve(hash);
      });
    });
  }

  async init() {
    if (this.promise) return this.promise;

    this.promise = Promise.resolve();

    /*
     * Return functions ID property from a functions object
     */
    this.passport.serializeUser(async (user, next) => {
      try {
        return next(null, user ? user.id : false);
      } catch (error) {
        return next(error, false);
      }
    });

    /*
     * Return functions from a functions ID
     */
    this.passport.deserializeUser(async (id, next) => {
      try {
        let user = await this.db.UserModel.findById(id);
        return next(null, user ? user : false);
      } catch (error) {
        return next(error, false);
      }
    });

    const getEmail = profile => {
      let email = null;
      for (let item of profile.emails) {
        if (item.type === "work" && validator.isEmail(item.value)) {
          email = item.value;
          break;
        }
      }
      if (!email && validator.isEmail(profile.emails[0].value))
        email = profile.emails[0].value;
      return email;
    };

    // Define a Passport strategy for provider
    for (let provider of this.providers) {
      provider.strategyOptions.callbackURL =
        provider.strategyOptions.callbackURL ||
        (this.config.appOrigins[0] || "") +
          constants.apiBase +
          "/oauth/" +
          _.toLower(provider.providerName) +
          "/callback";
      provider.strategyOptions.passReqToCallback = true;

      this.passport.use(
        new provider.Strategy(
          _.assign({}, provider.strategyOptions, {
            profileFields: ["id", "displayName", "email", "photos"]
          }),
          async (req, accessToken, refreshToken, profile, next) => {
            try {
              // load current user
              await req.getUser();

              // Look for a user in the database associated with this account.
              let user = await this.db.UserModel.findOne({
                "providers.name": provider.providerName,
                "providers.profile.id": profile.id
              });

              if (req.user) {
                // This section handles scenarios when a user is already signed in.

                if (user) {
                  // This section handles if the user is already logged in
                  if (req.user.id === user.id) {
                    // This section handles if the user is already logged in and is
                    // already linked to local account they are signed in with.
                    // If they are, all we need to do is update the Refresh Token
                    // value if we got one.
                    if (!refreshToken) return next(null, user);

                    for (let item of user.providers) {
                      if (
                        item.name === provider.providerName &&
                        item.profile.id === profile.id
                      ) {
                        item.profile = profile;
                        item.accessToken = accessToken;
                        item.refreshToken = refreshToken;

                        await user.validate();
                        await user.save();

                        return next(null, user);
                      }
                    }
                  } else {
                    // This section handles if a user is logged in but the oAuth
                    // account they are trying to link to is already linked to a
                    // different local account.

                    // This prevents users from linking an oAuth account to more
                    // than one local account at the same time.
                    return next(null, false);
                  }
                } else {
                  // This secion handles if a user is already logged in and is
                  // trying to link a new account.

                  // If we don't already have a name for the user, use value the
                  // name value specfied in their profile on the remote service.
                  req.user.name = req.user.name || profile.displayName;

                  // If we don't have a real email address for the user, use the
                  // email value specified in their profile on the remote service.
                  if (!req.user.email && profile.emails.length) {
                    let email = getEmail(profile);
                    if (email) {
                      req.user.email = email;
                      req.user.isEmailVerified = false;
                    }
                  }

                  // Save Profile ID, Access Token and Refresh Token values
                  // to the users local account, which links the accounts.
                  let prov = new this.db.ProviderModel({
                    name: provider.providerName,
                    profile: profile,
                    accessToken: accessToken,
                    refreshToken: refreshToken
                  });
                  await prov.validate();

                  req.user.providers.push(prov);

                  await req.user.validate();
                  await req.user.save();

                  return next(null, req.user);
                }
              } else {
                // This section handles scenarios when a user is not logged in.

                if (user) {
                  // This section handles senarios where the user is not logged in
                  // but they seem to have an account already, so we sign them in
                  // as that user.

                  // Update Access and Refresh Tokens for the user if we got them.
                  if (accessToken || refreshToken) {
                    let found = false;
                    for (let item of user.providers) {
                      if (
                        item.name === provider.providerName &&
                        item.profile.id === profile.id
                      ) {
                        item.profile = profile;
                        item.accessToken = accessToken;
                        item.refreshToken = refreshToken;
                        found = true;
                        break;
                      }
                    }
                    if (!found)
                      // never happens
                      return next(null, false);

                    await user.validate();
                    await user.save();
                  }

                  req.preCachePages({ user }).catch(console.error);
                  await this.signIn(user, req);
                  return next(null, user);
                } else {
                  // This section handles senarios where the user is not logged in
                  // and they don't have a local account already.

                  // First we check to see if a local account with the same email
                  // address as the one associated with their oAuth profile exists.
                  //
                  // This is so they can't accidentally end up with two accounts
                  // linked to the same email address.
                  let email = getEmail(profile);
                  if (!email) return next(null, false);

                  user = await this.db.UserModel.findOne({ email });

                  // If we already have a local account associated with their
                  // email address, the user should sign in with that account -
                  // and then they can link accounts if they wish.
                  //
                  // Note: Automatically linking them here could expose a
                  // potential security exploit allowing someone to pre-register
                  // or create an account elsewhere for another users email
                  // address then trying to sign in from it, so don't do that.
                  if (user) return next(null, false);

                  // If an account does not exist, create one for them and return
                  // a user object to passport, which will sign them in.
                  let prov = new this.db.ProviderModel({
                    name: provider.providerName,
                    profile: profile,
                    accessToken: accessToken,
                    refreshToken: refreshToken
                  });
                  await prov.validate();

                  user = new this.db.UserModel({
                    email: email,
                    name: profile.displayName,
                    password: this.fake.getString(64),
                    providers: [prov]
                  });

                  await user.validate();
                  await user.save();

                  return next(null, user);
                }
              }
            } catch (error) {
              return next(error, false);
            }
          }
        )
      );
    }
  }

  getStatus(user) {
    let isAuthenticated = !!user;
    let isAnonymous =
      isAuthenticated && _.includes(user.roles, constants.roles.ANONYMOUS);

    let providers = {};
    for (let provider of this.providers) {
      let name = _.toLower(provider.providerName);
      providers[name] = false;
      if (isAuthenticated) {
        for (let item of user.providers) {
          if (item.name === provider.providerName) {
            providers[name] = true;
            break;
          }
        }
      }
    }

    return {
      isAuthenticated,
      name: isAuthenticated ? user.name : null,
      email: isAuthenticated && !isAnonymous ? user.email : null,
      isEmailVerified:
        isAuthenticated && !isAnonymous ? user.isEmailVerified : null,
      roles: isAuthenticated ? user.roles : [],
      providers
    };
  }

  async signIn(user, req) {
    let userId = user.id.toString();
    let sessionId = _.get(req, "session.id");

    await new Promise((resolve, reject) => {
      req.login(user, error => {
        if (error) return reject(error);
        req.session.userId = userId;
        resolve();
      });
    });

    await req.saveSession();
    this.pubsub.publish("signIn", { signIn: { userId, sessionId } });
  }

  async signOut(req) {
    let userId = _.get(req, "user.id");
    let sessionId = _.get(req, "session.id");

    try {
      req.session.userId = null;
      req.logout();
    } catch (error) {
      console.error(error);
    }

    await req.saveSession();
    this.pubsub.publish("signOut", { signOut: { userId, sessionId } });
  }

  sendVerificationEmail(req, email, token) {
    let url = `${this.config.appOrigins[0]}/auth/verify?token=${token}`;
    return this.mailer.send({
      to: email,
      from: this.config.emailFrom,
      subject: this.i18n.translate("VERIFY_EMAIL_SUBJECT", { url }, req.locale),
      text: this.i18n.translate("VERIFY_EMAIL_TEXT", { url }, req.locale),
      html: this.i18n.translate("VERIFY_EMAIL_HTML", { url }, req.locale)
    });
  }
}

module.exports = Auth;
