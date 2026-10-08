const mongoose = require('mongoose');

const pathwayContentSchema = new mongoose.Schema({
    pathway:         { type: String, enum: ['web3_jobs','ai','nft','trading'], required: true },
    section:         { type: String, enum: ['update','class','resource','opportunity','event'], required: true },
    title:           { type: String, required: true, trim: true, maxlength: 200 },
    body:            { type: String, default: '' },
    // Scheduling (class / event)
    scheduledAt:     { type: Date,   default: null },
    endsAt:          { type: Date,   default: null },
    isLive:          { type: Boolean, default: false },
    isEnded:         { type: Boolean, default: false },
    // Resource
    resourceUrl:     { type: String, default: null },
    resourceType:    { type: String, enum: ['pdf','link','video','doc', null], default: null },
    resourceFilename:{ type: String, default: null },
    // Opportunity
    opportunityType: { type: String, enum: ['job','internship','bounty','gig','whitelist','other', null], default: null },
    externalUrl:     { type: String, default: null },
    // Display
    venue:           { type: String, default: null },
    isPinned:        { type: Boolean, default: false },
    isPublished:     { type: Boolean, default: true },
    createdBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

pathwayContentSchema.index({ pathway: 1, section: 1, createdAt: -1 });
pathwayContentSchema.index({ pathway: 1, isLive: 1 });
pathwayContentSchema.index({ pathway: 1, scheduledAt: 1 });

module.exports = mongoose.model('PathwayContent', pathwayContentSchema);
