import { supabase } from '$lib/supabase';
import type {
	NearbyTag,
	PlacementPose,
	Profile,
	SizeClass,
	Spot,
	SpotTag,
	SpotXY
} from '$lib/types';

export async function getProfile(userId: string): Promise<Profile> {
	const { data, error } = await supabase()
		.from('profiles')
		.select('id, handle, total_volume, used_volume')
		.eq('id', userId)
		.single();
	if (error) throw error;
	return data as Profile;
}

export async function nearbyTags(lat: number, lon: number, radiusM = 150): Promise<NearbyTag[]> {
	const { data, error } = await supabase().rpc('nearby_tags', {
		p_lat: lat,
		p_lon: lon,
		p_radius_m: radiusM
	});
	if (error) throw error;
	return (data ?? []) as NearbyTag[];
}

export async function placeTag(
	pose: PlacementPose,
	modelUrl: string,
	sizeClass: SizeClass,
	spot?: { id: string; xy: SpotXY }
): Promise<NearbyTag> {
	const { data, error } = await supabase().rpc('place_tag', {
		p_lat: pose.lat,
		p_lon: pose.lon,
		p_alt: pose.alt,
		p_heading: pose.heading,
		p_accuracy: pose.accuracy,
		p_model_url: modelUrl,
		p_size_class: sizeClass,
		p_device: { ua: navigator.userAgent, placed_via: spot ? 'spot-web-mvp' : 'sensor-ar-web-mvp' },
		p_spot_id: spot?.id ?? null,
		p_spot_xy: spot?.xy ?? null
	});
	if (error) throw error;
	// place_tag returns a tags row; adapt it to the NearbyTag shape for the scene.
	const t = data as {
		id: string; creator_id: string; heading: number | null; accuracy_m: number | null;
		model_url: string; size_class: SizeClass; created_at: string;
	};
	return {
		id: t.id,
		creator_id: t.creator_id,
		lat: pose.lat,
		lon: pose.lon,
		alt: pose.alt ?? 0,
		heading: t.heading,
		accuracy_m: t.accuracy_m,
		model_url: t.model_url,
		size_class: t.size_class,
		distance_m: 0,
		appraisals: 0,
		appraised: false,
		created_at: t.created_at
	};
}

/** Fetch one tag by id (share links / focus mode). distance_m is filled by the caller. */
export async function getTag(tagId: string): Promise<NearbyTag | null> {
	const { data, error } = await supabase().rpc('get_tag', { p_tag_id: tagId });
	if (error) throw error;
	const row = Array.isArray(data) ? data[0] : data;
	if (!row) return null;
	return { ...row, distance_m: 0, appraised: Boolean(row.appraised) } as NearbyTag;
}

export async function appraiseTag(tagId: string): Promise<void> {
	const { error } = await supabase().rpc('appraise_tag', { p_tag_id: tagId });
	if (error) throw error;
}

export async function reportTag(tagId: string, reason?: string): Promise<void> {
	const { error } = await supabase().rpc('report_tag', { p_tag_id: tagId, p_reason: reason ?? null });
	if (error) throw error;
}

// ---- Spots (wall-photo precision anchors) ----

export async function nearbySpots(lat: number, lon: number, radiusM = 300): Promise<Spot[]> {
	const { data, error } = await supabase().rpc('nearby_spots', {
		p_lat: lat,
		p_lon: lon,
		p_radius_m: radiusM
	});
	if (error) throw error;
	return (data ?? []) as Spot[];
}

export async function getSpot(spotId: string): Promise<Spot | null> {
	const { data, error } = await supabase().rpc('get_spot', { p_spot_id: spotId });
	if (error) throw error;
	const row = Array.isArray(data) ? data[0] : data;
	return (row ?? null) as Spot | null;
}

export async function createSpot(args: {
	lat: number;
	lon: number;
	accuracy: number | null;
	name: string | null;
	imagePath: string;
	targetPath: string;
}): Promise<Spot> {
	const { data, error } = await supabase().rpc('create_spot', {
		p_lat: args.lat,
		p_lon: args.lon,
		p_accuracy: args.accuracy,
		p_name: args.name,
		p_image_path: args.imagePath,
		p_target_path: args.targetPath
	});
	if (error) throw error;
	return data as Spot;
}

export async function spotTags(spotId: string): Promise<SpotTag[]> {
	const { data, error } = await supabase().rpc('spot_tags', { p_spot_id: spotId });
	if (error) throw error;
	return ((data ?? []) as SpotTag[]).map((t) => ({ ...t, appraised: Boolean(t.appraised) }));
}

export function spotFileUrl(path: string): string {
	return supabase().storage.from('spots').getPublicUrl(path).data.publicUrl;
}

export async function uploadSpotFile(path: string, body: Blob, contentType: string): Promise<void> {
	const { error } = await supabase()
		.storage.from('spots')
		.upload(path, body, { contentType, upsert: false });
	if (error) throw error;
}
