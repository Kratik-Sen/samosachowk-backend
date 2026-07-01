const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'],
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Please add a valid email',
      ],
    },
    phone: {
      type: String,
      default: '',
    },
    password: {
      type: String,
      required: [true, 'Please add a password'],
      minlength: 6,
      select: false,
    },
    role: {
      type: String,
      enum: ['vendor', 'sales', 'production', 'delivery', 'admin'],
      default: 'vendor',
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'suspended'],
      default: 'active',
    },
    availability_status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'inactive',
    },
    otpVerificationMethod: {
      type: String,
      enum: ['email', 'whatsapp'],
    },
    otpHash: String,
    otpExpiresAt: Date,
    otpRequestedAt: Date,
    otpVerifiedAt: Date,
    otpAttempts: {
      type: Number,
      default: 0,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    lastLoginAt: Date,
    resetPasswordToken: String,
    resetPasswordExpire: Date,
    resetPasswordRequestedAt: Date,
    resetPasswordVerificationMethod: {
      type: String,
      enum: ['email', 'whatsapp'],
    },
    resetPasswordAttempts: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Encrypt password using bcrypt
userSchema.pre('save', async function () {
  if (!this.isModified('password')) {
    return;
  }

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Match user entered password to hashed password in database
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
